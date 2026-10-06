import {resolveCreditStack} from "@waterx/sdk/account";
import {protocolClient,rpc,MAINNET_IDENTITY,NATIVE_USDC} from "./protocol";
/** Read-only registration/metadata preview, not an executable valuation or
 * custody redemption promise. No owner funds, signature or gas are consumed. */
export async function usdcFundingPreview(){
  const c=await protocolClient(),stack=resolveCreditStack(c.config,"USD");
  if(stack.creditType!==MAINNET_IDENTITY.settlementCoin||stack.decimals!==6)
    throw new Error("Settlement credit stack identity changed");
  const asset=stack.assets.find(a=>a.type===NATIVE_USDC);
  if(!asset||asset.decimal!==6)throw new Error("Pinned native USDC backing asset not registered");
  const metadata=await rpc.core.getCoinMetadata({coinType:asset.type});
  if(metadata.coinMetadata?.decimals!==6)throw new Error("USDC on-chain metadata does not match configuration");
  return {status:"CONFIG_REGISTRATION_AND_COIN_METADATA_VERIFIED",asOfMs:Date.now(),
    network:"sui:mainnet",source:c.config.network,backingCoinType:asset.type,backingDecimals:asset.decimal,
    creditCoinType:stack.creditType,creditDecimals:stack.decimals,vault:stack.vault,withdrawalQueue:stack.queue,
    registeredKeeperCount:stack.executors.length,
    configuredFees:{mintFeeScaled:asset.mint_fee_scaled,burnFeeScaled:asset.burn_fee_scaled,
      minimumBurnAmountAtomic:asset.min_burn_amount,scale:"1000000000 (SDK FLOAT_SCALE)",provenance:"Fetched mainnet config; current vault fee-state/dry-run still required."},
    intendedFunding:{backingAtomic:"10000000",backingAmount:"10 USDC",availableGas:"0.5 SUI is availability, not authorization",
      authorizedGasMIST:null,aggregateRoundCollateralLimitAtomic:"5000000",entryFeesIncluded:true},
    fundingPath:["Owner USDC coin","mintCreditToAccount (custody mint + consume deposit)","Owned WaterX account USD credit"],
    withdrawalPath:["Owner credit withdrawal request","Enqueue native withdrawal","Registered keeper executes native asset withdrawal","Verify receipt to owner USDC wallet"],
    winningsPath:["Verified market settlement","Permission-reviewed claim to owned account","Credit withdrawal/redemption to wallet USDC"],
    sdkValuation:"Native custody SDK documents 1:1 backing credit scaling; USDC and WaterX USD are distinct assets, not interchangeable wallet coins.",
    executablePreview:false,readyForOwnerApproval:false,
    blockers:["Current vault fee/limit and DirectRule state verification","Exact funding and redemption transaction simulation",
      "Keeper waiting time and recoverable withdrawal proof","Separate explicit gas limit"],
    semantics:"Configuration and coin metadata only; no funding, order, withdrawal, redemption or claim was submitted."};
}
