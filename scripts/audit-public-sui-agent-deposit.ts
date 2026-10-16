/**
 * Public-ledger evidence collection only: NO wallet signatures, mutations,
 * private keys, paid provider account, or deployment permissions.
 * Outputs only Sui's PUBLIC sender/effects/balance changes and wallet balances.
 */
import {SuiGrpcClient} from "@mysten/sui/grpc";
const txDigest="Dve8UyZtT5eqbKpC7sjPJ8TFM6SWW6NWQTgKbwZRzchT";
const owner="0xf9c496e9ac73fa9d6f75ba323b46fff11f714cd0cdcdc5751ebdff3d294f45ba";
const nativeUsdc="0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const waterxUsd="0xc70a37eafe54712b520cb6566e5a2d2f60bc70f32eb9fb08cac40394b5a96bf4::usd::USD";
const rpc =new SuiGrpcClient({network:"mainnet",baseUrl:"https://fullnode.mainnet.sui.io:443"});
const simpl=(v:unknown)=>JSON.parse(JSON.stringify(v,(_key,val)=>typeof val==="bigint"?val.toString():val));
try{
  const tx=await rpc.core.getTransaction({digest:txDigest,include:{
    transaction:true,effects:true,events:true,balanceChanges:true,
  }});
  const response=simpl(tx);
  console.log("TRANSACTION_KIND",response.$kind);
  if(response.$kind==="Transaction"){
    const t=response.Transaction;
    console.log("TRANSACTION_STATUS",JSON.stringify(t.effects?.status??null));
    console.log("TRANSACTION_EFFECTS",JSON.stringify(t.effects??null).slice(0,16000));
    console.log("TRANSACTION_BALANCE_CHANGES",JSON.stringify(t.balanceChanges??null).slice(0,20000));
    console.log("TRANSACTION_EVENTS",JSON.stringify(t.events??null).slice(0,16000));
    console.log("TRANSACTION_COMMANDS",JSON.stringify(t.transaction??null).slice(0,22000));
  }else console.log("TRANSACTION_UNRESOLVED",JSON.stringify(response).slice(0,14000));
}catch(error){console.log("TRANSACTION_LOOKUP_FAILED",String(error).slice(0,800));}
for(const [name,coinType] of [["SUI","0x2::sui::SUI"],["NATIVE_USDC",nativeUsdc],["WATERX_USD",waterxUsd]] as const){
 try {
   const r=await rpc.core.getBalance({owner,coinType});
   console.log("WALLET_BALANCE",name,JSON.stringify(simpl(r)).slice(0,1800));
 }catch(error){console.log("BALANCE_LOOKUP_FAILED",name,String(error).slice(0,320));}
}
