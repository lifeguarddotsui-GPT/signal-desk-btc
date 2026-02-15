import { useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { Badge } from "@/components/ui/badge";
import { Wallet } from "lucide-react";

export function WalletBalance() {
  const acct = useCurrentAccount();
  const [sui, setSui] = useState<number | null>(null);

  useEffect(() => {
    if (!acct?.address) {
      setSui(null);
      return;
    }
    let alive = true;

    async function fetchBalance() {
      try {
        const r = await fetch(`/api/balance/${acct!.address}`);
        const j = await r.json();
        if (alive && j.sui !== undefined) setSui(j.sui);
      } catch {
        if (alive) setSui(null);
      }
    }

    fetchBalance();
    const t = setInterval(fetchBalance, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [acct?.address]);

  if (!acct?.address) return null;

  return (
    <Badge variant="outline" className="font-mono text-[10px] sm:text-xs gap-1 sm:gap-1.5 px-1.5 sm:px-2" data-testid="badge-wallet-balance">
      <Wallet className="h-3 w-3 shrink-0" />
      {sui === null ? "..." : sui.toFixed(2)} SUI
    </Badge>
  );
}
