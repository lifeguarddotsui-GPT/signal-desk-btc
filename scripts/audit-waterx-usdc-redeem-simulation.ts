import {simulateOwnerTransaction} from "../server/agent/protocol";
const owner="0xf9c496e9ac73fa9d6f75ba323b46fff11f714cd0cdcdc5751ebdff3d294f45ba";
const accountId="0x57ee90694e63249c2ae75696239b8a6b0966d3ca49ce72b134fedf303c86761f";
// Public, unsigned, full Sui mainnet simulation. Not a withdrawal submission.
// Minimum 4.90 USDC is solely a PRE-FLIGHT scenario and not an owner-approved limit.
try{
 const result=await simulateOwnerTransaction(owner,{
   action:"REDEEM_USDC",accountId,amountAtomic:"5000000",minOutputAtomic:"4900000",
 });
 console.log("REDEEM_SIMULATION_STATUS",JSON.stringify({
   success:result.success,checksEnabled:result.checksEnabled,gasBudgetMist:result.gasBudgetMist,
   network:result.network,description:result.description,
 }));
 console.log("REDEEM_PREVIEW_ONLY","No wallet connected; no transaction signed, broadcast or submitted.");
}catch(error){console.log("REDEEM_SIMULATION_FAILED",String(error).slice(0,1400));}
