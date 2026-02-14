import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const NETWORK = (process.env.SUI_NETWORK as "mainnet" | "testnet") ?? "mainnet";
const RPC_URL = NETWORK === "testnet"
  ? "https://fullnode.testnet.sui.io:443"
  : "https://fullnode.mainnet.sui.io:443";

const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });

const DIGESTS = [
  "A2ACShzUVVYd1FwGaDwTFjQ1PdfvW64ZU2SgKwBDNAAu",
  "8W5c23jPeBsZ9W8154NwBnvyEjYsX2zc7yM6cEkVSYRZ",
  "7Zv5CABsanbKCcRsYpM4aEzDVjXttTW7sz6UeUpHJcof",
];

function short(x?: string) {
  if (!x) return "";
  return x.slice(0, 6) + "..." + x.slice(-4);
}

interface TraceResult {
  digest: string;
  network: string;
  status: string | null;
  sender: string | null;
  checkpoint: string | null;
  gasUsed: any;
  txKind: string | null;
  balanceChanges: Array<{
    owner: any;
    coinType: string;
    amount: string;
    direction: string;
  }>;
  objectsCreated: Array<{
    objectType: string;
    objectId: string;
    owner: any;
  }>;
  objectsMutated: number;
  suiTransfers: Array<{
    recipient: string;
    amountSui: number;
    direction: string;
  }>;
  error?: string;
}

async function traceDigest(digest: string): Promise<TraceResult> {
  const result: TraceResult = {
    digest,
    network: NETWORK,
    status: null,
    sender: null,
    checkpoint: null,
    gasUsed: null,
    txKind: null,
    balanceChanges: [],
    objectsCreated: [],
    objectsMutated: 0,
    suiTransfers: [],
  };

  try {
    const tx = await client.getTransactionBlock({
      digest,
      options: {
        showInput: true,
        showEffects: true,
        showEvents: true,
        showBalanceChanges: true,
        showObjectChanges: true,
      },
    });

    result.status = tx.effects?.status?.status ?? null;
    result.sender = tx.transaction?.data?.sender ?? null;
    result.checkpoint = tx.checkpoint ?? null;
    result.gasUsed = tx.effects?.gasUsed ?? null;
    result.txKind = (tx.transaction?.data as any)?.transaction?.kind ?? null;

    const bc = tx.balanceChanges ?? [];
    result.balanceChanges = bc.map((b: any) => ({
      owner: b.owner,
      coinType: b.coinType,
      amount: b.amount,
      direction: BigInt(b.amount) < 0n ? "SENT" : "RECEIVED",
    }));

    const suiChanges = bc.filter((b: any) => 
      b.coinType === "0x2::sui::SUI" || 
      b.coinType === "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
    );

    for (const c of suiChanges) {
      const ownerAddr = (c.owner as any)?.AddressOwner || (c.owner as any)?.ObjectOwner || "unknown";
      const amtMist = BigInt(c.amount);
      const amtSui = Number(amtMist) / 1e9;
      if (amtMist > 0n) {
        result.suiTransfers.push({
          recipient: ownerAddr,
          amountSui: amtSui,
          direction: "RECEIVED",
        });
      } else {
        result.suiTransfers.push({
          recipient: ownerAddr,
          amountSui: amtSui,
          direction: "SENT",
        });
      }
    }

    const oc = tx.objectChanges ?? [];
    result.objectsCreated = oc
      .filter((o: any) => o.type === "created")
      .slice(0, 20)
      .map((o: any) => ({
        objectType: o.objectType || "unknown",
        objectId: o.objectId || "unknown",
        owner: o.owner || "unknown",
      }));
    result.objectsMutated = oc.filter((o: any) => o.type === "mutated").length;
  } catch (e: any) {
    result.error = e.message || String(e);
  }

  return result;
}

async function main() {
  console.log(`\nTracing ${DIGESTS.length} deposits on ${NETWORK}...\n`);

  const results: TraceResult[] = [];

  for (const digest of DIGESTS) {
    console.log("==============================");
    console.log("DIGEST:", digest);

    const r = await traceDigest(digest);
    results.push(r);

    console.log("STATUS:", r.status || "ERROR: " + r.error);
    console.log("SENDER:", r.sender);
    console.log("CHECKPOINT:", r.checkpoint);
    console.log("TX KIND:", r.txKind);

    console.log("\nSUI BALANCE CHANGES:");
    for (const t of r.suiTransfers) {
      const arrow = t.direction === "RECEIVED" ? "  +" : "  -";
      console.log(`  ${arrow}${Math.abs(t.amountSui).toFixed(9)} SUI → ${short(t.recipient)} (${t.recipient})`);
    }

    if (r.objectsCreated.length > 0) {
      console.log("\nOBJECTS CREATED:", r.objectsCreated.length);
      for (const o of r.objectsCreated) {
        console.log(`  Type: ${o.objectType}`);
        console.log(`  ID:   ${o.objectId}`);
      }
    } else {
      console.log("\nOBJECTS CREATED: 0 (plain transfer, no contract)");
    }

    console.log("OBJECTS MUTATED:", r.objectsMutated);
    console.log("GAS USED:", JSON.stringify(r.gasUsed));
    console.log("");
  }

  const summary = {
    tracedAt: new Date().toISOString(),
    network: NETWORK,
    deposits: results,
    totalTransferred: {
      byRecipient: {} as Record<string, number>,
      grandTotal: 0,
    },
    assessment: {
      contractDeposit: false,
      receiptsCreated: false,
      recoverable: "UNKNOWN - depends on recipient address control",
      recommendation: "",
    },
  };

  const recipientTotals: Record<string, number> = {};
  for (const r of results) {
    for (const t of r.suiTransfers) {
      if (t.direction === "RECEIVED") {
        recipientTotals[t.recipient] = (recipientTotals[t.recipient] || 0) + t.amountSui;
      }
    }
  }
  summary.totalTransferred.byRecipient = recipientTotals;
  summary.totalTransferred.grandTotal = Object.values(recipientTotals).reduce((s, v) => s + v, 0);

  const anyCreated = results.some(r => r.objectsCreated.length > 0);
  const anyContractType = results.some(r => 
    r.objectsCreated.some(o => !o.objectType.includes("0x2::coin::Coin"))
  );

  summary.assessment.contractDeposit = anyContractType;
  summary.assessment.receiptsCreated = anyCreated && anyContractType;

  if (!anyContractType) {
    summary.assessment.recoverable = "NOT RECOVERABLE ON-CHAIN - funds were sent to EOA addresses via plain transfers, not deposited into a smart contract vault";
    summary.assessment.recommendation = "Replace plain transfer deposit flow with a Move vault contract that mints Receipt objects. Current deposits are irrecoverable unless recipient addresses are controlled by the platform.";
  }

  console.log("\n=== SUMMARY ===");
  console.log("Total SUI transferred:", summary.totalTransferred.grandTotal.toFixed(4));
  console.log("By recipient:");
  for (const [addr, amt] of Object.entries(recipientTotals)) {
    console.log(`  ${short(addr)}: ${amt.toFixed(4)} SUI`);
  }
  console.log("\nContract deposit:", summary.assessment.contractDeposit);
  console.log("Receipts created:", summary.assessment.receiptsCreated);
  console.log("Recoverable:", summary.assessment.recoverable);

  const fs = await import("fs");
  const path = await import("path");
  const reportPath = path.join(process.cwd(), "reports", "deposit_trace.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  console.log("\nReport saved to:", reportPath);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
