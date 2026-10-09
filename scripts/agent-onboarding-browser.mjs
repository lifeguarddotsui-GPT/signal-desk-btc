// Development-only CDP fixtures. No real wallets, signatures, orders or auth
// bypasses in application code. Start isolated Chromium on loopback port 9222.
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {Transaction} from "@mysten/sui/transactions";
import {defaultAgentPolicy} from "../shared/agent-policy.ts";

const base=process.env.REPLIT_DEV_DOMAIN&&`https://${process.env.REPLIT_DEV_DOMAIN}`;
if(!base)throw new Error("Development preview domain required");
const owner=`0x${"a".repeat(64)}`,accountId=`0x${"b".repeat(64)}`;
const tx=new Transaction();tx.setSender(owner);tx.setGasBudget(100_000_000);
tx.splitCoins(tx.gas,[tx.pure.u64(1000)]);
const transaction=await tx.toJSON();
const fixture=`(${function install(owner,accountId,policy,transaction) {
  const test=window.__onboardingTest={calls:[],signatures:0,txSignatures:0,mode:"single",balance:"0",delay:false,connected:false,listeners:[]};
  const account={address:owner,publicKey:new Uint8Array(32),chains:["sui:mainnet"],features:["sui:signPersonalMessage","sui:signAndExecuteTransaction"]};
  const wallet={version:"1.0.0",name:"Slush",icon:"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",chains:["sui:mainnet"],accounts:[],
    features:{"standard:connect":{version:"1.0.0",connect:async()=>{test.connected=true;wallet.accounts=[account];return {accounts:[account]};}},
      "standard:events":{version:"1.0.0",on:(_,listener)=>{test.listeners.push(listener);return()=>{};}},
      "sui:signPersonalMessage":{version:"1.0.0",signPersonalMessage:async()=>{test.signatures++;return {signature:"fixture-only"};}},
      "sui:signAndExecuteTransaction":{version:"1.0.0",signAndExecuteTransaction:async()=>{test.txSignatures++;return {digest:"1".repeat(44)};}}}};
  test.disconnect=()=>{wallet.accounts=[];test.connected=false;test.listeners.forEach(fn=>fn({accounts:[]}));};
  let state={owner,policy,policyVersion:1,status:"PAUSED",accountId:null,delegateAddress:null,delegateExpiresAtMs:null,
    paper:null,ledger:[],summary:[],blockers:[],balances:null,walletSessionExpiresAtMs:Date.now()+900000};
  try {const saved=JSON.parse(sessionStorage.getItem("onboarding-fixture-state")||"null");if(saved){state=saved;wallet.accounts=[account];test.connected=true;test.balance="25000000";}}catch{}
  const original=window.fetch.bind(window);
  window.fetch=async(input,options={})=>{
    const url=typeof input==="string"?input:input.url;
    if(!url.startsWith("/api/agent"))return original(input,options);
    const path=url.slice("/api/agent".length),body=options.body?JSON.parse(options.body):null;
    test.calls.push({path,body});
    const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
    if(path==="/capabilities")return respond({developmentOnly:true,sdkVersion:"fixture",network:"mainnet",
      globalExecutionDisabled:true,mainnetEnabled:false,ownerSetupSigning:true,defaultPolicy:policy,blockers:[],
      capabilities:{shadow:true,arming:false,execution:false,betaAuthorization:false},permissions:{prediction:1,account:0},
      config:{status:"VERIFIED_IDENTITY_ONLY",reason:"fixture",decimals:6}});
    if(path==="/challenge")return respond({message:"fixture-only login"});
    if(path==="/auth")return respond({walletSessionExpiresAtMs:state.walletSessionExpiresAtMs});
    if(path==="/logout")return respond({ok:true});
    if(path==="/state")return respond(state);
    if(path==="/accounts"){
      if(test.delay)await new Promise(resolve=>setTimeout(resolve,1500));
      if(test.mode==="error")return respond({error:"RPC_TIMEOUT"},503);
      return respond({accounts:test.mode==="empty"?[]:test.mode==="multiple"?[{accountId},{accountId:`0x${"c".repeat(64)}`}]:[{accountId}],
        network:"mainnet",settlementCoinType:"fixture::usd::USD",decimals:6,conversionAvailable:false});
    }
    if(path==="/account"){state={...state,accountId:body.accountId};sessionStorage.setItem("onboarding-fixture-state",JSON.stringify(state));return respond(state);}
    if(path==="/account-balance")return respond({accountId:state.accountId,network:"mainnet",availableAtomic:test.balance,
      availableBalanceUsd:(Number(test.balance)/1e6).toFixed(2),nativeUsdcSupported:true,walletUsdAtomic:"0",walletUsdcAtomic:"100000000",readAtMs:Date.now()});
    if(path==="/owner-simulation")return respond({success:true,checksEnabled:true,network:"mainnet",gasBudgetMist:100_000_000});
    if(path==="/owner-transaction")return respond({transaction,network:"mainnet",description:"Fixture reviewed funding",permissions:{account:0,prediction:1}});
    if(path==="/owner-confirm"){test.balance="25000000";return respond({success:true});}
    if(path==="/policy"){state={...state,policy:body.policy,policyVersion:state.policyVersion+1};sessionStorage.setItem("onboarding-fixture-state",JSON.stringify(state));return respond(state);}
    if(path==="/control"){state={...state,status:"PAUSED"};return respond(state);}
    throw new Error(`Unconfigured fixture path ${path}`);
  };
  window.addEventListener("wallet-standard:app-ready",e=>e.detail.register(wallet));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet",{detail:api=>api.register(wallet)}));
}.toString()})(${JSON.stringify(owner)},${JSON.stringify(accountId)},${JSON.stringify(defaultAgentPolicy)},${JSON.stringify(transaction)});`;

const target=await(await fetch("http://127.0.0.1:9222/json/new?about:blank",{method:"PUT"})).json();
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
let serial=0;const pending=new Map();
socket.addEventListener("message",e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async(expression)=>{const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
const wait=async(expression)=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error(`UI timeout: ${expression}`);};
const click=async(text)=>{const result=await evaluate(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`);assert.ok(result,`Button available: ${text}`);};
const results=[];
await send("Page.enable");await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument",{source:fixture});
await send("Page.navigate",{url:`${base}/agent`});
await wait(`!!document.querySelector(".ao-progress")&&window.__onboardingTest`);
await click("Connect Slush");
await wait(`document.querySelector(".ao-owner-account")?.textContent.includes("account") || [...document.querySelectorAll(".ao-account-area")].length>0 || document.body.innerText.includes("WaterX account found")`);
await wait(`window.__onboardingTest.calls.some(c=>c.path==="/account-balance")`);
assert.equal(await evaluate(`window.__onboardingTest.txSignatures`),0);
assert.equal(await evaluate(`window.__onboardingTest.calls.filter(c=>c.path==="/account").length`),1);
results.push("Single account discovered, verified selection persisted, no transaction signature on connect");
await click("Continue");
await wait(`document.body.innerText.includes("Choose amount to add")`);
await click("$25");await click("Add funds");
await wait(`window.__onboardingTest.calls.some(c=>c.path==="/owner-confirm")&&document.body.innerText.includes("$25.00")`);
assert.equal(await evaluate(`window.__onboardingTest.txSignatures`),1);
assert.equal(await evaluate(`window.__onboardingTest.calls.find(c=>c.path==="/owner-transaction").body.amountAtomic`),"25000000");
assert.equal(await evaluate(`window.__onboardingTest.calls.find(c=>c.path==="/owner-transaction").body.action`),"FUND_USDC");
results.push("Funding preset prepares and simulates the correct owner request; one wallet approval; reported balance updates");
await click("Continue");
await evaluate(`document.querySelector('button[aria-label="Continuous strategy"]')?.click() || [...document.querySelectorAll("button")].find(b=>b.textContent.includes("Continuous")&&b.className.includes("strategy"))?.click()`);
await wait(`document.body.innerText.includes("Confirm compounding")`);
await evaluate(`(()=>{const input=[...document.querySelectorAll("label")].find(l=>l.textContent.includes("Confirm compounding")).querySelector("input");input.click();})()`);
await click("Save strategy");
await wait(`window.__onboardingTest.calls.some(c=>c.path==="/policy")`);
const saved=await evaluate(`window.__onboardingTest.calls.find(c=>c.path==="/policy").body`);
assert.equal(saved.policy.compound,true);assert.equal(saved.policy.sizingPercent,10);assert.equal(saved.policy.minimumEdgePp,4);
assert.equal(saved.policy.dailyTurnoverCents,null);assert.equal(saved.policy.sessionTurnoverCents,defaultAgentPolicy.sessionTurnoverCents);
results.push("Continuous is deliberate, explicitly approved, versioned, and preserves bounded session limits");
await click("Continue");
assert.equal(await evaluate(`[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Authorize Agent").disabled`),true);
for(const width of [320,375,390,430]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),`No horizontal overflow at ${width}`);
}
results.push("Four phone widths have no horizontal overflow; live authorization/start stays unavailable");
await click("Try shadow mode");
await wait(`!!document.querySelector(".ao-run")`);
await click("PAUSE AGENT");
await wait(`!!document.querySelector(".ao-progress")`);
assert.equal(await evaluate(`window.__onboardingTest.txSignatures`),1);
results.push("Shadow entry and prominent pause never request signatures or submit orders");
await send("Page.reload");
await wait(`window.__onboardingTest.calls.some(c=>c.path==="/account-balance")`);
assert.equal(await evaluate(`window.__onboardingTest.signatures`),0);
assert.equal(await evaluate(`window.__onboardingTest.calls.filter(c=>c.path==="/account").length`),0);
results.push("Refresh restores the valid session/account without a new signature or rewriting account authority");
await mkdir(".local/screenshots/onboarding",{recursive:true});
for(const width of [320,375,390,430]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:1,mobile:true});
  const r=await send("Page.captureScreenshot",{format:"jpeg",quality:75});
  await writeFile(`.local/screenshots/onboarding/connect-${width}.jpg`,Buffer.from(r.data,"base64"));
}
console.log(JSON.stringify({fixtureOnly:true,results},null,2));
await writeFile(".local/screenshots/onboarding/browser-results.json",JSON.stringify({fixtureOnly:true,results},null,2));
socket.close();
await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
