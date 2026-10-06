import { PredictClient, getAccountIds, createAccount, deposit, withdraw, addDelegate, removeDelegate,
  setDelegatePredictionPermission, PREDICTION_PERM_PLACE_ORDER } from "@waterx/sdk/prediction";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import {mintCreditToAccount,routeNative,requestCreditWithdraw,enqueueWithdrawal,resolveCreditStack} from "@waterx/sdk/account";
import {PerpClient} from "@waterx/sdk/perp";

export const NATIVE_USDC="0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

export const configUrl = "https://main-v2.waterx-config.pages.dev/mainnet.json";
export const MAINNET_IDENTITY = {
  chainIdentifier:"4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  predictionPackage:"0x082328867e8b188412f5214342de5fa1524a398d01acefbdeb00ac08003b1745",
  accountPackage:"0x6cb6f3be75d37cd2b7db0e9fdac11b72ff0669765382cc9e00441d178b58bdbe",
  predictionRegistry:"0x3fafc1ec1148c8784c65a910f79c5e5f512d89ed8a5cc0625b5c5028e739f792",
  accountRegistry:"0x4bdad79586cad7617768bd991fd6988b796e88339d8ee4ff89c4e5652239bb45",
  settlementCoin:"0xc70a37eafe54712b520cb6566e5a2d2f60bc70f32eb9fb08cac40394b5a96bf4::usd::USD",
  predictionRegistryType:"0xa5cfafe6660a8bf37eedf1a09dba633048da374c30b835668473689668f9ef57::waterx_prediction::MarketRegistry<0xc70a37eafe54712b520cb6566e5a2d2f60bc70f32eb9fb08cac40394b5a96bf4::usd::USD>",
  accountRegistryType:"0xe308bd40bd81aa42b9245e4b51b3fe63801c77c78a76be4ce5902aae549f7221::account::AccountRegistry",
} as const;
export function assertMainnetConfigIdentity(c: PredictClient) {
  if(c.config.network!=="mainnet"||c.packageId()!==MAINNET_IDENTITY.predictionPackage||
    c.waterxAccountPackageId()!==MAINNET_IDENTITY.accountPackage||c.marketRegistry()!==MAINNET_IDENTITY.predictionRegistry||
    c.accountRegistry()!==MAINNET_IDENTITY.accountRegistry||c.settlementCoinType()!==MAINNET_IDENTITY.settlementCoin)
    throw new Error("Mainnet deployment identity changed; review required. No transaction prepared.");
}
async function verifiedMainnetClient() {
  const c=await PredictClient.mainnet({waterxConfigUrl:configUrl,timeoutMs:2500});
  assertMainnetConfigIdentity(c);
  const verification=Promise.all([rpc.core.getChainIdentifier(),
    rpc.core.getObject({objectId:MAINNET_IDENTITY.predictionPackage}),
    rpc.core.getObject({objectId:MAINNET_IDENTITY.accountPackage}),
    rpc.core.getObject({objectId:MAINNET_IDENTITY.predictionRegistry}),
    rpc.core.getObject({objectId:MAINNET_IDENTITY.accountRegistry}),
    rpc.core.getCoinMetadata({coinType:MAINNET_IDENTITY.settlementCoin})]);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const [chain,prediction,account,registry,accounts,metadata]=await Promise.race([
      verification,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Mainnet verification unavailable")),5000);}),
    ]);
    if(chain.chainIdentifier!==MAINNET_IDENTITY.chainIdentifier||prediction.object.type!=="package"||account.object.type!=="package"||
      registry.object.type!==MAINNET_IDENTITY.predictionRegistryType||accounts.object.type!==MAINNET_IDENTITY.accountRegistryType||
      metadata.coinMetadata?.decimals!==6)throw new Error("Mainnet chain, object or settlement metadata identity mismatch");
  }finally{if(timer)clearTimeout(timer);}
  return c;
}
let cached: Promise<PredictClient> | null = null;
let cachedAt = 0;
export function protocolClient() {
  // The SDK schema validates network and package IDs; never accept caller-supplied URLs.
  if (!cached || Date.now()-cachedAt>60000) {
    cachedAt=Date.now();
    cached = verifiedMainnetClient().catch(e => { cached=null; throw e; });
  }
  return cached;
}
export async function protocolStatus() {
  try {
    const c = await protocolClient();
    return {status:"VERIFIED_IDENTITY_ONLY",reason:"Mainnet identities verified. SDK order and native-USDC funding/redemption builders are implemented; owned-account simulation, credited balances, fee-inclusive economics and recovery are not yet verified.",
      source:configUrl,network:"mainnet",chainIdentifier:MAINNET_IDENTITY.chainIdentifier,
      decimals:6,settlementCoinType:c.settlementCoinType(),marketSemanticsVerified:false,
      settlements:c.config.objects.prediction.settlement_coin_types,
      packages:Object.fromEntries(["waterx_account","waterx_prediction","waterx_prediction_gift"].map(k=>[k,c.config.packages[k]?.published_at]))};
  } catch { return {status:"UNAVAILABLE",reason:"Pinned mainnet configuration or on-chain identity unavailable; owner transactions withheld.",source:configUrl,network:"mainnet",decimals:null,marketSemanticsVerified:false}; }
}
export const rpc = new SuiGrpcClient({network:"mainnet",baseUrl:"https://fullnode.mainnet.sui.io:443"});
export function address(v: unknown): string {
  if (typeof v !== "string" || !isValidSuiAddress(v)) throw new Error("Invalid Sui address");
  return normalizeSuiAddress(v);
}
export async function accountIds(owner: string) {
  const c = await protocolClient();
  return getAccountIds(c,{owner});
}
export async function assertAccountOwner(owner: string, accountId: unknown) {
  const id = address(accountId);
  if (!(await accountIds(owner)).some(a => normalizeSuiAddress(a) === id)) throw new Error("WaterX account is not owned by authenticated wallet");
  return id;
}
export async function ownerTransaction(owner: string, body: Record<string, unknown>) {
  const c = await protocolClient(), tx = new Transaction();
  tx.setSender(owner);
  // Account-management gas is additional to any future $5 settlement spend.
  // Owner still reviews and signs; there is no service signing/submission path.
  tx.setGasBudget(100_000_000);
  if(body.settlement!==undefined&&body.settlement!=="USD")throw new Error("Beta account management supports verified WaterX USD only; conversion is unavailable.");
  const settlement = "USD";
  const coinType = c.settlementCoinType(settlement);
  let description: string;
  if (body.action === "CREATE_ACCOUNT") {
    createAccount(c,tx,{alias:"Bluewater mainnet account"}); description="Create your WaterX mainnet account; Bluewater does not own it. SUI gas budget capped at 0.1 SUI; this is a limit, not a gas estimate.";
  } else {
    const accountId = await assertAccountOwner(owner,body.accountId);
    if (body.action === "AUTHORIZE") {
      throw new Error("Mainnet delegate opt-in unavailable until signer review and negative on-chain permission proofs.");
    } else if (body.action === "REVOKE") {
      removeDelegate(c,tx,{accountId,delegate:address(body.delegateAddress)});
      description="Owner revokes this delegate on mainnet; any existing positions remain. Gas budget capped at 0.1 SUI.";
    } else if (body.action === "FUND" || body.action === "FUND_USDC") {
      if (!Array.isArray(body.coinObjectIds) || body.coinObjectIds.length < 1 || body.coinObjectIds.length > 20 ||
        typeof body.amountAtomic !== "string" || !/^[1-9]\d*$/.test(body.amountAtomic) || BigInt(body.amountAtomic) > BigInt("18446744073709551615")) throw new Error("Provide coin objects and a positive settlement-native atomic amount");
      const ids = body.coinObjectIds.map(address);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate coin objects");
      const first = tx.object(ids[0]);
      if (ids.length > 1) tx.mergeCoins(first,ids.slice(1).map(id=>tx.object(id)));
      const [coin] = tx.splitCoins(first,[tx.pure.u64(body.amountAtomic)]);
      if(body.action==="FUND_USDC"){
        const stack=resolveCreditStack(c.config,"USD");
        if(stack.creditType!==MAINNET_IDENTITY.settlementCoin||!stack.assets.some(a=>a.type===NATIVE_USDC&&a.decimal===6))
          throw new Error("Native USDC is not registered for the pinned USD custody stack");
        // The custody mint and direct-rule deposit are consumed in the same PTB.
        // Never put a USDC Coin into the settlement-native deposit entrypoint.
        const fundingClient=new PerpClient("MAINNET",c.config,{});
        mintCreditToAccount(fundingClient,tx,{accountId,assetCoin:coin,assetType:NATIVE_USDC,creditType:"USD"});
        description=`Convert and deposit ${body.amountAtomic} atomic native USDC into your selected WaterX USD account via the official custody mint and direct deposit. These are different assets. Current fees and credited balance must be verified by simulation and confirmed effects. Gas budget capped at 0.1 SUI.`;
      }else{
        deposit(c,tx,{accountId,coin,coinType});
        description=`Deposit ${body.amountAtomic} atomic WaterX USD into your owned mainnet account. This does not convert USDC. Gas budget capped at 0.1 SUI.`;
      }
    } else if (body.action === "REDEEM_USDC") {
      if(typeof body.amountAtomic!=="string"||!/^[1-9]\d*$/.test(body.amountAtomic)||
        BigInt(body.amountAtomic)>BigInt("18446744073709551615")||
        typeof body.minOutputAtomic!=="string"||!/^[1-9]\d*$/.test(body.minOutputAtomic)||
        BigInt(body.minOutputAtomic)>BigInt("18446744073709551615"))
        throw new Error("Positive USD redemption amount and owner-approved minimum USDC output are required");
      const stack=resolveCreditStack(c.config,"USD");
      if(!stack.assets.some(a=>a.type===NATIVE_USDC&&a.decimal===6)||!stack.executors.length)
        throw new Error("Native USDC redemption asset or registered withdrawal keeper unavailable");
      const fundingClient=new PerpClient("MAINNET",c.config,{});
      const route=routeNative(fundingClient,tx,{assetType:NATIVE_USDC,minOutput:BigInt(body.minOutputAtomic)});
      const request=requestCreditWithdraw(fundingClient,tx,{accountId,amount:BigInt(body.amountAtomic),
        recipient:owner,route,creditType:"USD"});
      enqueueWithdrawal(fundingClient,tx,{withdrawRequest:request,creditType:"USD"});
      description=`Request ${body.amountAtomic} atomic WaterX USD redemption through the native USDC withdrawal queue, to your wallet only, with minimum output ${body.minOutputAtomic}. A registered keeper must process it; this transaction is a queued request, not receipt of USDC. Gas budget capped at 0.1 SUI.`;
    } else if (body.action === "WITHDRAW") {
      if (typeof body.amountAtomic !== "string" || !/^[1-9]\d*$/.test(body.amountAtomic) || BigInt(body.amountAtomic)>BigInt("18446744073709551615")) throw new Error("Invalid withdrawal amount");
      withdraw(c,tx,{accountId,amount:body.amountAtomic,recipient:owner,coinType});
      description="OWNER-SIGNED withdrawal to your wallet. Bluewater delegate cannot perform this operation.";
    } else throw new Error("Unsupported owner action");
  }
  return {transaction:await tx.toJSON(),description,network:"mainnet",gasBudgetMist:100_000_000,permissions:{account:0,prediction:1}};
}
export async function simulateOwnerTransaction(owner:string,body:Record<string,unknown>) {
  const prepared=await ownerTransaction(owner,body);
  const bytes=await Transaction.from(prepared.transaction).build({client:rpc});
  const result=await rpc.core.simulateTransaction({transaction:bytes,checksEnabled:true,
    include:{effects:true,events:true,balanceChanges:true}});
  if(result.$kind!=="Transaction"||!result.Transaction.status.success)
    throw new Error("Owner transaction simulation failed with validation enabled; no funds moved");
  return {success:true,checksEnabled:true,gasBudgetMist:prepared.gasBudgetMist,network:"mainnet",
    description:prepared.description};
}