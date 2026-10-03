import { PredictClient, getAccountIds, createAccount, deposit, withdraw, addDelegate, removeDelegate,
  setDelegatePredictionPermission, PREDICTION_PERM_PLACE_ORDER } from "@waterx/sdk/prediction";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

export const configUrl = "https://staging-v2.waterx-config.pages.dev/testnet.json";
let cached: Promise<PredictClient> | null = null;
let cachedAt = 0;
export function protocolClient() {
  // The SDK schema validates network and package IDs; never accept caller-supplied URLs.
  if (!cached || Date.now()-cachedAt>60000) {
    cachedAt=Date.now();
    cached = PredictClient.testnet({waterxConfigUrl:configUrl,timeoutMs:2500}).catch(e => { cached=null; throw e; });
  }
  return cached;
}
export async function protocolStatus() {
  try {
    const c = await protocolClient();
    return {status:"AVAILABLE",reason:null,source:configUrl,network:"testnet",
      settlements:c.config.objects.prediction.settlement_coin_types,
      packages:Object.fromEntries(["waterx_account","waterx_prediction","waterx_prediction_gift"].map(k=>[k,c.config.packages[k]?.published_at]))};
  } catch { return {status:"UNAVAILABLE",reason:"Official testnet configuration unavailable; owner transactions withheld.",source:configUrl}; }
}
export const rpc = new SuiGrpcClient({network:"testnet",baseUrl:"https://fullnode.testnet.sui.io:443"});
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
  const settlement = typeof body.settlement === "string" ? body.settlement : c.settlement;
  const coinType = c.settlementCoinType(settlement);
  let description: string;
  if (body.action === "CREATE_ACCOUNT") {
    createAccount(c,tx,{alias:"Bluewater testnet account"}); description="Create your WaterX testnet account; Bluewater does not own it.";
  } else {
    const accountId = await assertAccountOwner(owner,body.accountId);
    if (body.action === "AUTHORIZE") {
      const delegate = address(body.delegateAddress), expiry = Number(body.expiresAtMs);
      if (!Number.isSafeInteger(expiry) || expiry <= Date.now()+60000 || expiry > Date.now()+7*86400000) throw new Error("Delegate expiry must be between one minute and seven days");
      addDelegate(c,tx,{accountId,delegate,alias:"Bluewater restricted testnet delegate",permissions:0,expiresAtMs:expiry});
      setDelegatePredictionPermission(c,tx,{accountId,delegate,permissions:PREDICTION_PERM_PLACE_ORDER});
      description="Authorize prediction PLACE_ORDER (1) only. Account permissions 0: no withdrawal, receive, or delegate-management authority. Testnet only.";
    } else if (body.action === "REVOKE") {
      removeDelegate(c,tx,{accountId,delegate:address(body.delegateAddress)});
      description="Owner revokes this delegate on testnet; any existing positions remain.";
    } else if (body.action === "FUND") {
      if (!Array.isArray(body.coinObjectIds) || body.coinObjectIds.length < 1 || body.coinObjectIds.length > 20 ||
        typeof body.amountAtomic !== "string" || !/^[1-9]\d*$/.test(body.amountAtomic) || BigInt(body.amountAtomic) > BigInt("18446744073709551615")) throw new Error("Provide coin objects and a positive settlement-native atomic amount");
      const ids = body.coinObjectIds.map(address);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate coin objects");
      const first = tx.object(ids[0]);
      if (ids.length > 1) tx.mergeCoins(first,ids.slice(1).map(id=>tx.object(id)));
      const [coin] = tx.splitCoins(first,[tx.pure.u64(body.amountAtomic)]);
      deposit(c,tx,{accountId,coin,coinType});
      description=`Deposit ${body.amountAtomic} atomic units of ${coinType} into YOUR WaterX testnet account. Gas and actual balances require wallet review.`;
    } else if (body.action === "WITHDRAW") {
      if (typeof body.amountAtomic !== "string" || !/^[1-9]\d*$/.test(body.amountAtomic) || BigInt(body.amountAtomic)>BigInt("18446744073709551615")) throw new Error("Invalid withdrawal amount");
      withdraw(c,tx,{accountId,amount:body.amountAtomic,recipient:owner,coinType});
      description="OWNER-SIGNED withdrawal to your wallet. Bluewater delegate cannot perform this operation.";
    } else throw new Error("Unsupported owner action");
  }
  return {transaction:await tx.toJSON(),description,network:"testnet",permissions:{account:0,prediction:1}};
}