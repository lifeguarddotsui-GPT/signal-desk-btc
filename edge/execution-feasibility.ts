/**
 * Bounded, isolated compatibility probe. NEVER submits a transaction.
 * Not a replacement for production's committed decisions or owner consent.
 * Uses the existing collector parser and the current pure qualification policy.
 */
import {getCurrentWaterxRound} from "../server/waterx/source";
import {evaluateTimedDecision,TIMED_STRATEGY,GATE_MS,GATE_GRACE_MS} from "../shared/timed-decision";
import type {LockObservation} from "../shared/lock-readiness";
import {Transaction} from "@mysten/sui/transactions";
import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519";
import {verifyTransactionSignature} from "@mysten/sui/verify";
import {getUnresolvedMarkets,placeOrder,withdraw,claim,cancelOrder} from "@waterx/sdk/prediction";
import {protocolClient,rpc,MAINNET_IDENTITY} from "../server/agent/protocol";
import {createProtectedDelegate,recoverProtectedDelegate,assertRestrictedTransaction,
  verifySignerPermit} from "../infrastructure/agent-signer/protection";
import {defaultAgentPolicy} from "../shared/agent-policy";

type Cursor={toArray():any[];rowsRead:number;rowsWritten:number};
type Storage={get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;
  setAlarm(at:number):Promise<void>;deleteAlarm():Promise<void>;
  sql:{exec(query:string,...args:any[]):Cursor;databaseSize?:number}};
type Context={storage:Storage};
type Env={PROBE_AUTH:string;WRAPPING_KEY_HEX:string;
  EXECUTION_PROBE:{idFromName(name:string):unknown;get(id:unknown):{fetch(req:Request):Promise<Response>}}};
type Feed={round:{roundId:string;intervalMinutes:5|15;startMs:number;expiryMs:number};
  observations:LockObservation[];lastGate:number};
type State={startMs:number;stopMs:number;ticks:number;providerCalls:number;errors:number;
  maxDelayMs:number;maxDurationMs:number;feeds:Partial<Record<5|15,Feed>>;stopped:boolean;
  sdk?:Record<string,unknown>;recoveries:number};
const WINDOW=31*60000,POLL=5000,KEY="executionProbeState";
declare const __PROBE_BUILD__:string;
const BUILD=typeof __PROBE_BUILD__==="undefined"?"local":__PROBE_BUILD__;
const respond=(x:unknown,status=200)=>Response.json(x,{status,headers:{"Cache-Control":"no-store"}});

export class ExecutionProbe {
  private readonly instanceId=crypto.randomUUID();
  constructor(private ctx:Context,private env:Env) {
    this.sql("CREATE TABLE IF NOT EXISTS gate_journal (key TEXT PRIMARY KEY,scheduled INTEGER,evaluated INTEGER,result TEXT,delay_ms INTEGER)");
    this.sql("CREATE TABLE IF NOT EXISTS final_decisions (key TEXT PRIMARY KEY,committed INTEGER,payload TEXT)");
    this.sql("CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY,owner TEXT,round_key TEXT,status TEXT,cents INTEGER,digest TEXT,UNIQUE(owner,round_key))");
    this.sql("CREATE TABLE IF NOT EXISTS stage_evidence (key TEXT PRIMARY KEY,payload TEXT)");
    this.sql("CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY,reads INTEGER,writes INTEGER)");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO usage VALUES(1,0,0)");
  }
  private sql(q:string,...args:any[]) {
    const cursor=this.ctx.storage.sql.exec(q,...args),rows=cursor.toArray();
    // Meter SQL queries, including index writes, using actual runtime cursors.
    // The usage counter's own update and KV/alarm operations are reported
    // separately; do not pretend this counter equals account billing.
    try{this.ctx.storage.sql.exec("UPDATE usage SET reads=reads+?,writes=writes+? WHERE id=1",cursor.rowsRead,cursor.rowsWritten);}catch{}
    return rows;
  }
  private async wrapping() {
    if(!/^[a-f0-9]{64}$/.test(this.env.WRAPPING_KEY_HEX))throw new Error("Probe-only wrapping secret unavailable");
    const raw=Uint8Array.from(this.env.WRAPPING_KEY_HEX.match(/../g)!,b=>parseInt(b,16));
    return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
  }
  async fetch(req:Request) {
    const action=new URL(req.url).pathname;
    if(action==="/start") {
      if(await this.ctx.storage.get(KEY))return respond({error:"Probe already started; refusing to reset evidence"},409);
      const now=Date.now(),state:State={startMs:now,stopMs:now+WINDOW,ticks:0,
        providerCalls:0,errors:0,maxDelayMs:0,maxDurationMs:0,feeds:{},stopped:false,recoveries:0};
      await this.ctx.storage.put(KEY,state);await this.ctx.storage.setAlarm(now+1000);
      return respond({startMs:now,stopMs:state.stopMs,submissionEnabled:false});
    }
    if(action==="/sdk")return respond(await this.sdk());
    if(action==="/codec")return respond(await this.sdk("sdk-codec",true));
    if(action==="/crypto") {
      if(this.sql("SELECT key FROM stage_evidence WHERE key='crypto'").length)
        return respond({error:"Crypto subcheck already recorded"},409);
      const envelope=await this.ctx.storage.get<any>("protectedProbeDelegate");
      if(!envelope)return respond({error:"No probe-only delegate envelope"},409);
      const key=await recoverProtectedDelegate(envelope,await this.wrapping());
      // Inert transaction, distinct from prediction order compatibility.
      // Nonexistent gas reference makes it incapable of spending any funds.
      const tx=new Transaction();tx.setSender(key.toSuiAddress());tx.setGasOwner(key.toSuiAddress());
      tx.setGasPrice(1000);tx.setGasBudget(10000000);
      tx.setGasPayment([{objectId:Ed25519Keypair.generate().toSuiAddress(),version:"1",digest:"11111111111111111111111111111111"}]);
      const bytes=await tx.build({client:rpc}),signed=await key.signTransaction(bytes);
      const signatureVerified=(await verifyTransactionSignature(bytes,signed.signature)).toSuiAddress()===key.toSuiAddress();
      const digest=await tx.getDigest({client:rpc}),a=envelope.owner,b=Ed25519Keypair.generate().toSuiAddress();
      for(const [id,owner] of [["synthetic-a",a],["synthetic-b",b]])
        this.sql("INSERT OR IGNORE INTO intents VALUES(?,?,?,?,?,?)",id,owner,"synthetic-uncertain-round","UNKNOWN",500,digest);
      this.sql("INSERT OR IGNORE INTO intents VALUES(?,?,?,?,?,?)","synthetic-duplicate",a,"synthetic-uncertain-round","UNKNOWN",500,digest);
      const evidence:Record<string,unknown>={scope:"INERT_TRANSACTION_AND_SYNTHETIC_LEDGER_NOT_ORDER_EXECUTION",
        transactionBytes:bytes.length,signatureVerified,submissionEnabled:false,
        duplicateSuppressed:this.sql("SELECT count(*) AS n FROM intents WHERE owner=?",a)[0].n===1,
        ownersSeparatelyFiltered:[a,b].every(owner=>this.sql("SELECT sum(cents) AS n FROM intents WHERE owner=?",owner)[0].n===500)};
      try {
        const result=await rpc.core.simulateTransaction({transaction:bytes,checksEnabled:true,include:{effects:true}});
        evidence.simulationRpcReturned=true;evidence.simulationChecksEnabled=true;
        evidence.simulationSuccessful=result.$kind==="Transaction"&&result.Transaction.status.success;
        evidence.resultKind=result.$kind;
      }catch(e){evidence.simulationRpcReturned=false;evidence.simulationError=(e as Error).message.slice(0,240);}
      evidence.interpretation="Crypto compatibility and expected unfunded rejection only; not owned-account simulation, on-chain permission proof, submission or fills.";
      this.sql("INSERT INTO stage_evidence VALUES('crypto',?)",JSON.stringify(evidence));
      return respond(evidence);
    }
    if(action==="/recovery") {
      const envelope=await this.ctx.storage.get<any>("protectedProbeDelegate");
      if(!envelope)return respond({error:"Run SDK probe first"},409);
      const recovered=await recoverProtectedDelegate(envelope,await this.wrapping());
      const rows=this.sql("SELECT id,status,cents,digest FROM intents ORDER BY id");
      const state=await this.ctx.storage.get<State>(KEY);
      if(state){state.recoveries++;await this.ctx.storage.put(KEY,state);}
      const evidence={protectedKeyRecovered:recovered.toSuiAddress()===envelope.delegateAddress,
        uncertainReservationsRetained:rows.filter(r=>r.status==="UNKNOWN").length,
        buildId:BUILD,instanceId:this.instanceId,submissions:0,resubmissions:0,scope:"SYNTHETIC_UNFUNDED_RESTART_CHECK"};
      this.sql("INSERT OR REPLACE INTO stage_evidence VALUES('recovery',?)",JSON.stringify(evidence));
      return respond(evidence);
    }
    if(action==="/stop") {
      const state=await this.ctx.storage.get<State>(KEY);
      if(state){state.stopped=true;await this.ctx.storage.put(KEY,state);}
      await this.ctx.storage.deleteAlarm();return respond({stopped:true});
    }
    if(action==="/report") {
      const state=await this.ctx.storage.get<State>(KEY);
      const gates=this.sql("SELECT result,count(*) AS n,max(delay_ms) AS max_delay FROM gate_journal GROUP BY result");
      const finals=this.sql("SELECT count(*) AS n FROM final_decisions");
      const stages=this.sql("SELECT key,payload FROM stage_evidence");
      return respond({scope:"ISOLATED_UNFUNDED_FEASIBILITY_NOT_PRODUCTION_ACCEPTANCE",
        buildId:BUILD,instanceId:this.instanceId,
        submissionEnabled:false,postgresQueries:0,browserRequestsRequired:false,state,gates,finals,
        journal:this.sql("SELECT key,scheduled,evaluated,result,delay_ms FROM gate_journal ORDER BY scheduled,key"),
        decisions:this.sql("SELECT key,committed,payload FROM final_decisions"),
        stages:stages.map(r=>({key:r.key,evidence:JSON.parse(r.payload)})),
        usage:this.sql("SELECT * FROM usage"),
        storageBytes:this.ctx.storage.sql.databaseSize??null,
        billingCaveat:"SQL cursor counts exclude the meter's own updates, KV writes and alarm writes. Platform analytics remain authoritative."});
    }
    return respond({error:"Not found"},404);
  }
  async alarm() {
    const state=await this.ctx.storage.get<State>(KEY);
    if(!state||state.stopped)return;
    const begin=Date.now();
    if(begin>=state.stopMs){state.stopped=true;await this.ctx.storage.put(KEY,state);await this.ctx.storage.deleteAlarm();return;}
    const planned=Math.floor(begin/POLL)*POLL;
    state.maxDelayMs=Math.max(state.maxDelayMs,begin-planned);state.ticks++;
    for(const interval of [5,15] as const) {
      state.providerCalls++;
      try {
        const result=await getCurrentWaterxRound(interval,undefined,{timeoutMs:2500});
        if(result.status!=="LIVE")throw new Error("No live exact round");
        const r=result.detail.round;
        if(!state.feeds[interval]||state.feeds[interval]!.round.roundId!==r.id) {
          state.feeds[interval]={round:{roundId:r.id,intervalMinutes:interval,startMs:r.startsAt*1000,expiryMs:r.endsAt*1000},observations:[],lastGate:0};
        }
        const f=state.feeds[interval]!,received=Date.now();
        const up=r.sides.up.probabilityCents,down=r.sides.down.probabilityCents;
        const sourceAt=result.sourceTimestamp?Date.parse(result.sourceTimestamp):NaN;
        if(up!==null&&down!==null)f.observations.push({atMs:received,receivedAtMs:received,
          providerSourceAtMs:Number.isFinite(sourceAt)?sourceAt:null,sourceHealthy:true,
          probabilityUp:up/100,probabilityDown:down/100});
        f.observations=f.observations.filter(o=>o.receivedAtMs>=received-90000);
        const due=Math.floor((received-f.round.startMs)/GATE_MS);
        // Do not retroactively evaluate missed gates with later observations.
        for(let gate=Math.max(1,f.lastGate+1);gate<=due;gate++){
          const at=f.round.startMs+gate*GATE_MS;if(at>=f.round.expiryMs)break;
          const key=`${interval}:${r.id}:${gate}`,delay=received-at;
          const evaluation=evaluateTimedDecision(f.round,f.observations.filter(o=>o.receivedAtMs<=at),at);
          const classification=delay>GATE_GRACE_MS?"MISSED_GATE":evaluation.qualified?"QUALIFIED":"WAIT";
          this.sql("INSERT OR IGNORE INTO gate_journal VALUES(?,?,?,?,?)",key,at,received,classification,delay);
          if(classification==="QUALIFIED"){
            const first=`${interval}:${r.id}`;
            this.sql("INSERT OR IGNORE INTO final_decisions VALUES(?,?,?)",first,received,
              JSON.stringify({strategy:TIMED_STRATEGY,scope:"PROBE_ONLY",side:evaluation.liveSide,
                round:f.round,gate,scheduledAtMs:at,committedAtMs:received,components:evaluation.components}));
            // Event-driven dispatch receipt is persisted in the same actor.
            this.sql("INSERT OR IGNORE INTO stage_evidence VALUES(?,?)","dispatch:"+first,
              JSON.stringify({committedAtMs:received,dispatchedAtMs:Date.now(),submission:false}));
          }
        }
        f.lastGate=due;
      }catch{state.errors++;}
    }
    state.maxDurationMs=Math.max(state.maxDurationMs,Date.now()-begin);
    await this.ctx.storage.put(KEY,state);
    // Absolute cadence; no browser, origin heartbeat, Replit PG or cron needed.
    await this.ctx.storage.setAlarm(Math.min(state.stopMs,Math.ceil((Date.now()+1)/POLL)*POLL));
  }
  private async sdk(evidenceKey="sdk",explicitSyntheticReference=false) {
    if(this.sql("SELECT payload FROM stage_evidence WHERE key=?",evidenceKey).length)
      return {error:"SDK probe is single-pass; use the existing evidence",submissionEnabled:false};
    const stages:Record<string,unknown>={scope:"SYNTHETIC_UNFUNDED_COMPATIBILITY",submissionEnabled:false};
    const begin=Date.now();
    try {
      const c=await protocolClient(),markets=await getUnresolvedMarkets(c);
      stages.pinnedMainnetIdentity=true;stages.registryRead=true;stages.unresolvedMarkets=markets.length;
      const market=markets.find(m=>!m.paused&&!m.resolved);if(!market)throw new Error("No unresolved market for codec probe");
      const master=await this.wrapping(),owner=Ed25519Keypair.generate(),ownerAddress=owner.toSuiAddress();
      const envelope=await createProtectedDelegate(ownerAddress,master);
      await this.ctx.storage.put("protectedProbeDelegate",envelope);
      const key=await recoverProtectedDelegate(envelope,master);
      stages.encryptedKeyRoundTrip=key.toSuiAddress()===envelope.delegateAddress;
      const account=Ed25519Keypair.generate().toSuiAddress(),now=Date.now();
      const permit={domain:"bluewater-mainnet-session-v1" as const,network:"sui:mainnet" as const,
        owner:ownerAddress,accountId:account,delegateAddress:key.toSuiAddress(),nonce:"a".repeat(64),policyVersion:1,
        policy:{...defaultAgentPolicy,signalSource:"EXPERIMENTAL_QUALIFICATION_GATES" as const,sessionGasBudgetMist:10000000},
        issuedAtMs:now-1,expiresAtMs:now+60000,experimentalConfirmed:true,compoundingConfirmed:false,pilotOneOrder:true};
      const message=new TextEncoder().encode(JSON.stringify(permit)),signedPermit=await owner.signPersonalMessage(message);
      await verifySignerPermit(message,signedPermit.signature,now);stages.explicitPermitVerification=true;
      const order={marketId:market.marketIdHex,selection:"YES" as const,maxSpendAtomic:"5000000",
        minSharesAtomic:"1",priceCapBps:10000,expiryAtMs:now+10000,gasBudgetMist:10000000};
      const tx=new Transaction();tx.setSender(key.toSuiAddress());tx.setGasOwner(key.toSuiAddress());
      tx.setGasBudget(order.gasBudgetMist);tx.setGasPrice(1000);
      // The first pass deliberately tries normal object resolution. The codec
      // subcheck supplies a nonexistent owned reference explicitly so encoding
      // and signatures can be exercised without pretending the account exists.
      if(explicitSyntheticReference)tx.objectRef({objectId:account,version:"1",digest:"11111111111111111111111111111111"});
      stages.syntheticObjectReferenceProvided=explicitSyntheticReference;
      // An entropy-generated object ID that was never created/funded on chain.
      tx.setGasPayment([{objectId:Ed25519Keypair.generate().toSuiAddress(),version:"1",digest:"11111111111111111111111111111111"}]);
      placeOrder(c,tx,{accountId:account,receiverAccountId:account,marketId:order.marketId,selection:"YES",
        maxSpend:order.maxSpendAtomic,minShares:order.minSharesAtomic,priceCapBps:order.priceCapBps,expiryTs:order.expiryAtMs});
      assertRestrictedTransaction(c,permit,order,tx.getData(),now);stages.restrictedOrderGuard=true;
      const withdrawal=new Transaction();withdrawal.setSender(key.toSuiAddress());withdrawal.setGasOwner(key.toSuiAddress());
      withdrawal.setGasBudget(order.gasBudgetMist);
      withdraw(c,withdrawal,{accountId:account,amount:"1",recipient:ownerAddress,coinType:MAINNET_IDENTITY.settlementCoin});
      try{assertRestrictedTransaction(c,permit,order,withdrawal.getData(),now);stages.withdrawalGuardDenied=false;}
      catch{stages.withdrawalGuardDenied=true;}
      const bytes=await tx.build({client:rpc}),signed=await key.signTransaction(bytes);
      stages.transactionBytes=bytes.length;stages.serializedTransactionSigning=true;
      stages.signatureMatchesDelegate=(await verifyTransactionSignature(bytes,signed.signature)).toSuiAddress()===key.toSuiAddress();
      const digest=await tx.getDigest({client:rpc});
      this.sql("INSERT INTO intents VALUES(?,?,?,?,?,?)","sdk-probe",ownerAddress,"synthetic-round","UNKNOWN",500,digest);
      this.sql("INSERT OR IGNORE INTO intents VALUES(?,?,?,?,?,?)","duplicate-probe",ownerAddress,"synthetic-round","RESERVED",500,digest);
      stages.duplicateSuppressed=this.sql("SELECT count(*) AS n FROM intents WHERE owner=?",ownerAddress)[0].n===1;
      stages.unknownReservationCents=this.sql("SELECT sum(cents) AS n FROM intents WHERE owner=? AND status='UNKNOWN'",ownerAddress)[0].n;
      // Real fullnode validation. The expected failure is NOT permission proof
      // or successful owned-wallet simulation, and no submit RPC exists here.
      try{
        const simulation=await rpc.core.simulateTransaction({transaction:bytes,checksEnabled:true,include:{effects:true,events:true}});
        stages.simulationRpcReturned=true;stages.simulationChecksEnabled=true;
        stages.simulationSuccessful=simulation.$kind==="Transaction"&&simulation.Transaction.status.success;
        stages.simulationScope="Expected rejection: synthetic nonexistent gas/account, not a funded permission test";
      }catch(e){stages.simulationRpcReturned=false;stages.simulationError=String((e as Error).message).slice(0,240);}
      // Check codec availability only; these are NOT actual claim/cancel proofs.
      stages.claimBuilderAvailable=typeof claim==="function";stages.cancelBuilderAvailable=typeof cancelOrder==="function";
      stages.fillTracking="NOT_PROVEN_NO_OWNER_APPROVED_ORDER";stages.settlement="NOT_PROVEN_NO_OWNER_APPROVED_POSITION";
    }catch(e){stages.failedStage=String((e as Error).message).slice(0,240);}
    stages.wallClockMs=Date.now()-begin;
    this.sql("INSERT INTO stage_evidence VALUES(?,?)",evidenceKey,JSON.stringify(stages));
    return stages;
  }
}
export default {
  async fetch(req:Request,env:Env){
    if(!env.PROBE_AUTH||req.headers.get("Authorization")!==`Bearer ${env.PROBE_AUTH}`)
      return respond({error:"Unauthorized"},401);
    if(!["/start","/sdk","/codec","/crypto","/report","/recovery","/stop"].includes(new URL(req.url).pathname))
      return respond({error:"No submission endpoint exists"},404);
    return env.EXECUTION_PROBE.get(env.EXECUTION_PROBE.idFromName("bounded-pass")).fetch(req);
  },
};
