import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Transaction } from "@mysten/sui/transactions";
import { createAccount, addDelegate, setDelegatePredictionPermission, removeDelegate, placeOrder,
  PREDICTION_PERM_PLACE_ORDER, PREDICTION_PERM_CANCEL_ORDER, PREDICTION_PERM_CLAIM,
  PREDICTION_PERM_REQUEST_CLOSE, ACCOUNT_PERM_WITHDRAW, ACCOUNT_PERM_MANAGE_DELEGATES,
  ACCOUNT_PERM_RECEIVE, ACCOUNT_PERM_ALL } from "@waterx/sdk/prediction";
import { protocolClient, configUrl } from "../server/agent/protocol";
const c=await protocolClient();
const owner="0x"+ "1".padStart(64,"0"),accountId="0x"+"2".padStart(64,"0"),delegate="0x"+"3".padStart(64,"0");
const draft=(name:string,build:(tx:Transaction)=>unknown)=>{
  const tx=new Transaction();tx.setSender(owner);build(tx);
  return {name,status:"UNSIGNED_BUILDER_ONLY_NOT_ONCHAIN_PROOF",commands:tx.getData().commands,
    sha256:createHash("sha256").update(JSON.stringify(tx.getData())).digest("hex")};
};
const evidence={
  capturedAt:new Date().toISOString(),sdkVersion:JSON.parse(readFileSync("node_modules/@waterx/sdk/package.json","utf8")).version,
  source:configUrl,network:c.network,packages:c.packageIds(),
  settlementCoinTypes:c.config.objects.prediction.settlement_coin_types,
  permissions:{prediction:{placeOrder:PREDICTION_PERM_PLACE_ORDER,cancel:PREDICTION_PERM_CANCEL_ORDER,
    claim:PREDICTION_PERM_CLAIM,requestClose:PREDICTION_PERM_REQUEST_CLOSE},
    account:{withdraw:ACCOUNT_PERM_WITHDRAW,manageDelegates:ACCOUNT_PERM_MANAGE_DELEGATES,receive:ACCOUNT_PERM_RECEIVE,all:ACCOUNT_PERM_ALL},
    granted:{account:0,prediction:PREDICTION_PERM_PLACE_ORDER}},
  drafts:[
    draft("createAccount",tx=>createAccount(c,tx,{alias:"Unsigned SDK proof fixture"})),
    draft("addDelegate + setDelegatePredictionPermission",tx=>{
      addDelegate(c,tx,{accountId,delegate,alias:"Unsigned fixture",permissions:0,expiresAtMs:Date.now()+3600000});
      setDelegatePredictionPermission(c,tx,{accountId,delegate,permissions:PREDICTION_PERM_PLACE_ORDER});
    }),
    draft("removeDelegate",tx=>removeDelegate(c,tx,{accountId,delegate})),
    draft("placeOrder",tx=>placeOrder(c,tx,{accountId,marketId:"0x"+"a".repeat(64),selection:"YES",maxSpend:"100000",
      minShares:"10000",priceCapBps:5000,expiryTs:Date.now()+5000})),
  ],
  safety:"These are unsigned in-memory builder fixtures only. No signing, submission, funding, account creation or chain permission proof was performed."
};
writeFileSync("reports/bluewater-agent-sdk-evidence.json",JSON.stringify(evidence,null,2));
console.log(JSON.stringify({sdkVersion:evidence.sdkVersion,network:evidence.network,permissionMasks:evidence.permissions.granted,
  draftCount:evidence.drafts.length,chainProof:false}));