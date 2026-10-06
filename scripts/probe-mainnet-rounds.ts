/** Read-only public contract check. No wallet, seed, signer or submission. */
import {getMarketById,getRegistry} from "@waterx/sdk/prediction";
import {protocolClient,MAINNET_IDENTITY,configUrl} from "../server/agent/protocol";
import {getCurrentWaterxRound} from "../server/waterx/source";
const startedAt=new Date().toISOString();
const client=await protocolClient();
const registry=await getRegistry(client);
const rounds=[];
for(const interval of [5,15] as const){
  const publicRound=await getCurrentWaterxRound(interval);
  const r=publicRound.detail.round;
  const mapping={up:r.sides.up.trade??null,down:r.sides.down.trade??null};
  const base={interval,roundId:r.id,startMs:r.startsAt*1000,expiryMs:r.endsAt*1000,
    publicStatus:publicRound.status,mapping,observedAt:publicRound.requestReceivedAt};
  if(!mapping.up||!mapping.down||mapping.up.marketId!==mapping.down.marketId||
    mapping.up.selection!=="YES"||mapping.down.selection!=="NO"){
    rounds.push({...base,status:"MAPPING_UNAVAILABLE",orderAllowed:false});continue;
  }
  try{
    const market=await getMarketById(client,{marketId:mapping.up.marketId});
    rounds.push({...base,status:"ON_CHAIN_REGISTRATION_READ",market,orderAllowed:false,
      reason:"Registration alone is not an executable quote, fee proof or owner authorization."});
  }catch(error){
    rounds.push({...base,status:"MAINNET_REGISTRATION_UNVERIFIED",orderAllowed:false,
      sdkError:error instanceof Error?error.message:"Unknown SDK read error",
      reason:"Official SDK could not read this public round's market ID from the pinned mainnet registry. Do not substitute another registry or network."});
  }
}
console.log(JSON.stringify({startedAt,completedAt:new Date().toISOString(),configUrl,
  mainnetIdentity:MAINNET_IDENTITY,settlementDecimals:6,registry,rounds,
  betaLive:false,transactionsBuilt:0,transactionsSubmitted:0},(_,value)=>
  typeof value==="bigint"?value.toString():value,2));