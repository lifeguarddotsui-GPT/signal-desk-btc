import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { agentPolicySchema, defaultAgentPolicy } from "../../shared/agent-policy";
import { agentPool, agentTransaction, readAgent, ledger, blockers } from "./store";
import { address, accountIds, accountFundingInfo, assertAccountOwner, ownerTransaction, simulateOwnerTransaction, protocolClient, protocolStatus, rpc } from "./protocol";
import { Transaction } from "@mysten/sui/transactions";
import { matchesOwnerIntent } from "./intent";
import {websiteControlPlaneStatus} from "../../infrastructure/agent-signer/control-plane";
import {liveExecutionReadiness} from "./live-readiness";
import {assessMainnetPilot} from "../../shared/agent-mainnet-preflight";

const hash = (s:string)=>createHash("sha256").update(s).digest("hex");
const throttles = new Map<string,{count:number;until:number}>();
type OwnerRequest = Request & { agentOwner?:string; agentSessionExpiresAtMs?:number };
function origin(req: Request): string {
  const value = req.get("Origin");
  if (!value || new URL(value).host !== req.get("Host")) throw new Error("Same-origin request required");
  return value;
}
function safe(fn:(req:OwnerRequest,res:Response)=>Promise<unknown>) {
  return (req:OwnerRequest,res:Response,next:NextFunction)=>void fn(req,res).catch(e=>{
    // No raw RPC/database errors, signatures or key material in responses/logs.
    const message = e instanceof Error ? e.message : "Agent request failed";
    if ((e as {code?:string}).code || /fetch|grpc|RPC|network|connect/i.test(message)) res.status(503).json({error:"Agent storage or protocol unavailable. No order submitted."});
    else res.status(400).json({error:message.slice(0,300)});
  });
}
function cookie(req: Request): string | null {
  const v = req.get("Cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith("bluewater_agent="))?.slice(16);
  return v && /^[a-f0-9]{64}$/.test(v) ? v : null;
}
async function authenticate(req: OwnerRequest,res: Response,next: NextFunction) {
  try {
    const token=cookie(req);
    const rows=token?(await agentPool.query("SELECT owner,expires_at FROM bluewater_agent_sessions WHERE token_hash=$1 AND network='mainnet' AND expires_at>clock_timestamp()",[hash(token)])).rows:[];
    if (!rows.length) {res.status(401).json({error:"Connect a compatible mainnet Sui wallet and verify wallet ownership first."});return;}
    req.agentOwner=rows[0].owner;req.agentSessionExpiresAtMs=new Date(rows[0].expires_at).getTime();next();
  } catch {res.status(503).json({error:"Agent authentication storage unavailable."});}
}
export function registerAgentRoutes(app:Express) {
  app.use("/api/agent", (req,res,next)=>{
    res.set("Cache-Control","no-store");
    if(req.method!=="GET")try{origin(req);}catch{res.status(403).json({error:"Same-origin request required."});return;}
    next();
  });
  app.get("/api/agent/capabilities",safe(async(_req,res)=>{
    const controlPlane=websiteControlPlaneStatus(process.env);
    const config=await protocolStatus();
    res.json({developmentOnly:false,sdkVersion:"6.1.0",network:"mainnet",globalExecutionDisabled:true,mainnetEnabled:false,
      ownerSetupSigning:config.status==="VERIFIED_IDENTITY_ONLY",
      readiness:liveExecutionReadiness(controlPlane),
      capabilities:{authentication:true,accountReads:true,accountSelection:true,
        betaAuthorization:false,arming:false,execution:false,shadow:process.env.NODE_ENV==="development"},
      betaReleased:false,walletConnection:"OPEN",defaultRoundCollateralCents:500,roundLimitOwnerEditable:true,defaultCompounding:false,
      executableQuote:null,ownerOrderAvailable:false,delegatedOrderAvailable:false,
      controlPlane,
      blockers:[...blockers,controlPlane.administrationCredentialPresent
        ?"Website still holds Cloudflare deployment authority. Funded signer invocation is blocked."
        :"Signer control-plane separation still requires independent operator, connector and production verification."],
      defaultPolicy:defaultAgentPolicy,permissions:{prediction:1,account:0},config});
  }));
  app.post("/api/agent/challenge",safe(async(req,res)=>{
    const now=Date.now(),key=req.ip??"unknown";
    throttles.forEach((v,k)=>{if(v.until<=now)throttles.delete(k);});
    const rate=throttles.get(key);
    if(!rate&&throttles.size>=4096){res.status(429).json({error:"Wallet verification busy."});return;}
    if(rate&&rate.until>now&&rate.count>=15){res.status(429).json({error:"Too many wallet challenges; retry in one minute."});return;}
    throttles.set(key,{count:rate&&rate.until>now?rate.count+1:1,until:now+60000});
    if(req.body?.chain!=="sui:mainnet")throw new Error("sui:mainnet wallet required");
    const owner=address(req.body?.address),site=origin(req);
    const message=`Bluewater Agent wallet verification\nOrigin: ${site}\nNetwork: sui:mainnet\nOwner: ${owner}\nNonce: ${randomBytes(32).toString("hex")}\nExpires: ${new Date(now+120000).toISOString()}\nThis message grants no transaction, withdrawal or trading permission.`;
    const c=await agentPool.connect();
    try{
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext('bluewater-auth-challenge-cap'))");
      await c.query("DELETE FROM bluewater_agent_challenges WHERE expires_at<clock_timestamp()-interval '1 day'");
      const pending=await c.query("SELECT count(*)::int AS n FROM bluewater_agent_challenges WHERE consumed_at IS NULL AND expires_at>clock_timestamp()");
      if(Number(pending.rows[0].n)>=500){await c.query("COMMIT");res.status(429).json({error:"Wallet verification busy."});return;}
      await c.query(`INSERT INTO bluewater_agent_challenges(token_hash,owner,origin,network,expires_at)
        VALUES($1,$2,$3,'sui:mainnet',clock_timestamp()+interval '2 minutes')`,[hash(message),owner,site]);
      await c.query("COMMIT");
    }catch(error){await c.query("ROLLBACK").catch(()=>{});throw error;}finally{c.release();}
    res.json({message});
  }));
  app.post("/api/agent/auth",safe(async(req,res)=>{
    const {message,signature,chain}=req.body??{};
    if(chain!=="sui:mainnet")throw new Error("sui:mainnet wallet required");
    if(typeof message!=="string"||message.length>1024||typeof signature!=="string"||signature.length>8192)throw new Error("Wallet signature required");
    const key=hash(message),site=origin(req);
    const challenge=(await agentPool.query(`SELECT owner FROM bluewater_agent_challenges
      WHERE token_hash=$1 AND origin=$2 AND network='sui:mainnet'
        AND consumed_at IS NULL AND expires_at>clock_timestamp()`,[key,site])).rows[0];
    if(!challenge)throw new Error("Expired or replayed wallet challenge");
    const publicKey=await verifyPersonalMessageSignature(new TextEncoder().encode(message),signature);
    if(address(publicKey.toSuiAddress())!==challenge.owner)throw new Error("Signature owner mismatch");
    const token=randomBytes(32).toString("hex");
    const expiresAtMs=await agentTransaction(challenge.owner,async(c)=>{
      const consumed=await c.query(`UPDATE bluewater_agent_challenges SET consumed_at=clock_timestamp()
        WHERE token_hash=$1 AND owner=$2 AND origin=$3 AND network='sui:mainnet'
          AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash`,[key,challenge.owner,site]);
      if(consumed.rows.length!==1)throw new Error("Expired or replayed wallet challenge");
      const session=await c.query("INSERT INTO bluewater_agent_sessions(token_hash,owner,expires_at,network) VALUES($1,$2,clock_timestamp()+interval '15 minutes','mainnet') RETURNING expires_at",[hash(token),challenge.owner]);
      return new Date(session.rows[0].expires_at).getTime();
    });
    res.cookie("bluewater_agent",token,{httpOnly:true,sameSite:"strict",secure:origin(req).startsWith("https:"),maxAge:15*60000,path:"/api/agent"});
    res.json(await readAgent(challenge.owner,expiresAtMs));
  }));
  app.post("/api/agent/logout",safe(async(req,res)=>{
    const token=cookie(req);
    if(token){
      const session=(await agentPool.query("SELECT owner FROM bluewater_agent_sessions WHERE token_hash=$1 AND network='mainnet'",[hash(token)])).rows[0];
      if(session)await agentTransaction(session.owner,async(c,row)=>{
        await c.query("UPDATE bluewater_agents SET status='PAUSED',revision=revision+1 WHERE owner=$1",[session.owner]);
        await ledger(c,session.owner,"SESSION_DISCONNECTED",Number(row.policy_version),{signing:false,submission:false});
        await c.query("DELETE FROM bluewater_agent_sessions WHERE token_hash=$1",[hash(token)]);
      });
    }
    res.clearCookie("bluewater_agent",{path:"/api/agent"});res.json({ok:true});
  }));
  app.use("/api/agent",authenticate);
  // Explicit authenticated inspection; never called by a running timer or public dashboard.
  // A failed provider read is reported as UNVERIFIED, never as a funded/tradable account.
  app.post("/api/agent/mainnet-preflight",safe(async(req,res)=>{
    const state=await readAgent(req.agentOwner!,req.agentSessionExpiresAtMs);
    const funding=state.accountId?await accountFundingInfo(req.agentOwner!,state.accountId).catch(()=>null):null;
    const plane=websiteControlPlaneStatus(process.env);
    const report=assessMainnetPilot({
      policy:state.policy,nowMs:Date.now(),ownerSessionExpiresAtMs:state.walletSessionExpiresAtMs??null,
      accountId:state.accountId,accountBalanceAtomic:funding?.availableAtomic??null,
      accountBalanceReadAtMs:funding?.readAtMs??null,
      // Configuration values and a prepared delegate are never proof of isolated authority.
      controlPlaneIsolated:plane.separationVerified===true,
      onChainDelegateVerified:false,signerProvisioned:false,executableQuoteVerified:false,
      continuouslyLeasedWorkerVerified:false,releaseApproved:false
    });
    res.json({...report,accountBalanceVerification:funding?"VERIFIED_OWNER_ACCOUNT_READ":"UNAVAILABLE",
      currentPolicyVersion:state.policyVersion,network:"mainnet",
      intentionalSafetyGate:"No live order, authorization, key generation or trading permission is created."});
  }));
  app.get("/api/agent/state",safe(async(req,res)=>res.json(await readAgent(req.agentOwner!,req.agentSessionExpiresAtMs))));
  app.post("/api/agent/policy",safe(async(req,res)=>{
    const p=agentPolicySchema.parse(req.body?.policy);
    if(p.network!=="mainnet")throw new Error("This beta accepts mainnet policies only");
    if(req.body?.acknowledged!==true)throw new Error("Explicit review and approval of the session limits required");
    if(p.signalSource==="EXPERIMENTAL_QUALIFICATION_GATES"&&req.body?.experimentalConfirmed!==true)
      throw new Error("Explicit consent to the uncalibrated experimental gate strategy required");
    if(p.compound&&req.body?.compoundingConfirmed!==true)throw new Error("Explicit compounding authorization required");
    await agentTransaction(req.agentOwner!,async(c,row)=>{
      const version=Number(row.policy_version)+1;
      await c.query("INSERT INTO bluewater_agent_policies(owner,version,policy) VALUES($1,$2,$3)",[req.agentOwner,version,JSON.stringify(p)]);
      await c.query("UPDATE bluewater_agents SET policy=$2,policy_version=$3,status='PAUSED',revision=revision+1,updated_at=clock_timestamp() WHERE owner=$1",[req.agentOwner,JSON.stringify(p),version]);
      await ledger(c,req.agentOwner!,"POLICY_CHECK",version,{policy:p,action:"POLICY_CHANGED_AGENT_PAUSED",previousVersion:Number(row.policy_version)});
    });res.json(await readAgent(req.agentOwner!));
  }));
  app.post("/api/agent/control",safe(async(req,res)=>{
    if(process.env.NODE_ENV!=="development"&&!["PAUSE","STOP_GOAL"].includes(req.body?.action)){
      res.status(409).json({error:"Production arming is not released. Wallet identity is not trading authority."});return;
    }
    await agentTransaction(req.agentOwner!,async(c,row)=>{
      const p=agentPolicySchema.parse(row.policy),action=req.body?.action;
      let paper=row.paper,status="PAUSED",event="PAUSED";
      if(action==="ARM_SHADOW"){
        if(req.body?.acknowledged!==true)throw new Error("Explicit risk acknowledgement required");
        if(p.frequency==="EVERY_ELIGIBLE_ROUND"&&!p.edgeEnabled&&req.body?.edgeOffConfirmed!==true)throw new Error("Confirm every-round execution without edge filter");
        if(p.reserveCents===0&&req.body?.zeroReserveConfirmed!==true)throw new Error("Confirm zero reserve");
        if(p.network!=="mainnet")throw new Error("Accept the fixed mainnet beta policy before starting observation");
        const capital=Number(req.body?.paperCapitalCents);
        if(!paper){
          if(!Number.isSafeInteger(capital)||capital<1||capital>100_000_000)throw new Error("Set positive paper starting capital in cents");
          paper={sessionId:randomBytes(16).toString("hex"),startingCents:capital,availableCents:capital,committedCents:0,turnoverCents:0,realizedPnlCents:0,highWaterCents:capital,consecutiveLosses:0,targetCents:p.targetCents,startedAt:new Date().toISOString(),day:new Date().toISOString().slice(0,10),dayStartingCents:capital,dayTurnoverCents:0,dayRealizedPnlCents:0};
        } else if(paper.stopReason || row.status==="LOSS_STOP" || row.status==="TARGET_REACHED")throw new Error("Stopped session must be closed before starting a new goal");
        status="SHADOW";event="RESUMED";
      }else if(action==="STOP_GOAL"){event="GOAL_CANCELLED";paper=null;}
      else if(action!=="PAUSE")throw new Error("LIVE release is disabled; supported actions are PAUSE, ARM_SHADOW, STOP_GOAL");
      await ledger(c,req.agentOwner!,event,Number(row.policy_version),{mode:status,policy:p,paper,previousPaper:action==="STOP_GOAL"?row.paper:undefined});
      await c.query("UPDATE bluewater_agents SET status=$2,paper=$3,revision=revision+1,updated_at=clock_timestamp() WHERE owner=$1",[req.agentOwner,status,JSON.stringify(paper)]);
    });res.json(await readAgent(req.agentOwner!));
  }));
  app.post("/api/agent/accounts",safe(async(req,res)=>{
    const c=await protocolClient();
    res.json({accounts:(await accountIds(req.agentOwner!)).map(accountId=>({accountId})),network:"mainnet",settlementCoinType:c.settlementCoinType(),decimals:6,
      conversionAvailable:false,collateral:"WaterX USD (not wallet USDC)",balance:null});
  }));
  app.post("/api/agent/account",safe(async(req,res)=>{
    const id=await assertAccountOwner(req.agentOwner!,req.body?.accountId);
    await agentTransaction(req.agentOwner!,async(c,row)=>{
      // Reconnecting/discovering the same account must not revoke its delegation.
      if(row.account_id===id)return;
      await c.query("UPDATE bluewater_agents SET account_id=$2,status='PAUSED',delegate_address=NULL,delegate_expires_at_ms=NULL,revision=revision+1 WHERE owner=$1",[req.agentOwner,id]);
      await ledger(c,req.agentOwner!,"ACCOUNT_LINKED",Number(row.policy_version),{accountId:id,network:"mainnet"});
    });res.json(await readAgent(req.agentOwner!));
  }));
  app.post("/api/agent/account-balance",safe(async(req,res)=>{
    const selected=(await agentPool.query("SELECT account_id FROM bluewater_agents WHERE owner=$1",[req.agentOwner])).rows[0]?.account_id;
    if(!selected||selected!==address(req.body?.accountId))throw new Error("Select your owned WaterX account first");
    res.json(await accountFundingInfo(req.agentOwner!,selected));
  }));
  app.post("/api/agent/delegate",safe(async(req,res)=>{
    res.status(409).json({error:"Isolated encrypted mainnet signer service is not provisioned. No key generated."});
  }));
  app.post("/api/agent/owner-simulation",safe(async(req,res)=>{
    if(req.body?.action!=="CREATE_ACCOUNT"){
      const row=await readAgent(req.agentOwner!);
      if(row.policyAcceptanceRequired||!row.accountId||address(req.body?.accountId)!==row.accountId)
        throw new Error("Select this owned WaterX mainnet account before simulation");
    }
    res.json(await simulateOwnerTransaction(req.agentOwner!,req.body??{}));
  }));
  app.post("/api/agent/owner-transaction",safe(async(req,res)=>{
    if(req.body?.action==="AUTHORIZE"){
      throw new Error("Mainnet delegate authorization is not released");
    }
    if(req.body?.action!=="CREATE_ACCOUNT"){
      const row=await readAgent(req.agentOwner!);
      if(row.policyAcceptanceRequired||!row.accountId||address(req.body?.accountId)!==row.accountId)
        throw new Error("Accept the mainnet beta policy and select this owned WaterX mainnet account first");
    }
    // Always simulate the exact prepared operation again. The earlier UI
    // simulation is informative, not authority and not a reusable price promise.
    const verified=await simulateOwnerTransaction(req.agentOwner!,req.body??{});
    const prepared={transaction:verified.transaction,description:verified.description,
      network:"mainnet" as const,permissions:{account:0,prediction:1}};
    await agentTransaction(req.agentOwner!,async(c,row)=>ledger(c,req.agentOwner!,"OWNER_TRANSACTION_PREPARED",Number(row.policy_version),
      {action:req.body.action,transaction:prepared.transaction,accountId:req.body.accountId??null,
        delegateAddress:req.body.delegateAddress??null,expiresAtMs:req.body.expiresAtMs??null,network:"mainnet"}));
    res.json(prepared);
  }));
  app.post("/api/agent/owner-confirm",safe(async(req,res)=>{
    const digest=req.body?.digest;
    if(typeof digest!=="string"||! /^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(digest))throw new Error("Valid Sui transaction digest required");
    const result=await rpc.core.getTransaction({digest,include:{transaction:true,effects:true,events:true}});
    if(result.$kind!=="Transaction"||!result.Transaction.status.success||!result.Transaction.transaction||
      address(result.Transaction.transaction.sender)!==req.agentOwner)throw new Error("Confirmed successful owner-signed mainnet transaction required");
    const actual=Transaction.from(JSON.stringify(result.Transaction.transaction)).getData();
    await agentTransaction(req.agentOwner!,async(c,row)=>{
      const duplicate=(await c.query("SELECT 1 FROM bluewater_agent_ledger WHERE owner=$1 AND event='OWNER_TRANSACTION_CONFIRMED' AND details->>'digest'=$2",[req.agentOwner,digest])).rows;
      if(duplicate.length)return;
      // Reconciliation must survive a long RPC outage. These are owner-signed
      // account-management intents, not reusable price quotes or trading permits.
      const prior=(await c.query("SELECT details FROM bluewater_agent_ledger WHERE owner=$1 AND event='OWNER_TRANSACTION_PREPARED' ORDER BY id DESC LIMIT 20",[req.agentOwner])).rows;
      const intent=prior.find(r=>{
        if(r.details.action!==req.body.action)return false;
        const wanted=Transaction.from(r.details.transaction).getData();
        return matchesOwnerIntent(wanted,actual);
      })?.details;
      if(!intent)throw new Error("Transaction does not match a retained prepared owner operation; no resubmission is authorized");
      // Confirmation proves sender, successful effects and exact prepared intent.
      // It does NOT prove delegate effective permission bits; live stays disabled.
      await ledger(c,req.agentOwner!,"OWNER_TRANSACTION_CONFIRMED",Number(row.policy_version),
        {digest,action:intent.action,network:"mainnet",sender:req.agentOwner,delegatePermissionsVerified:false});
      if(intent.action==="REVOKE") {
        await c.query("UPDATE bluewater_agents SET status='PAUSED',delegate_address=NULL,delegate_expires_at_ms=NULL,revision=revision+1 WHERE owner=$1",[req.agentOwner]);
        await ledger(c,req.agentOwner!,"DELEGATE_REVOKED",Number(row.policy_version),{digest,permissionsVerified:false});
      }
    });
    res.json(await readAgent(req.agentOwner!));
  }));
  app.post("/api/agent/kill-switch",safe(async(req,res)=>{
    const configured=process.env.OWNER_CONTROL_TOKEN,provided=req.get("X-Owner-Control")??"";
    if(!configured||provided.length!==configured.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(configured))){res.status(403).json({error:"Operator authorization required."});return;}
    if(req.body?.disabled!==true)throw new Error("Release gate does not permit enabling live execution");
    const c=await agentPool.connect();
    try{await c.query("BEGIN");await c.query("UPDATE bluewater_agent_execution_control SET disabled=true WHERE singleton=true");
      await c.query("INSERT INTO bluewater_agent_control_audit(disabled) VALUES(true)");await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
    res.json({globalExecutionDisabled:true,mainnetEnabled:false});
  }));
}