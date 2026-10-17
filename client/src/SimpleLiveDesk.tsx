import * as React from "react";
import "./SimpleLiveDesk.css";

type Interval = 5 | 15;
type Round = { id: string; startMs: number; expiryMs: number };

type Props = {
  interval: Interval;
  now: number;
  round: Round | null;
  referencePrice: number | null;
  referenceConfirmed: boolean;
  quoteFresh: boolean;
  quoteAtMs: number | null;
  upAsk: number | null;
  downAsk: number | null;
};

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

export function simpleWaterxPosition(askCents: number | null, quoteCurrent: boolean) {
  if (!quoteCurrent || typeof askCents !== "number" || !Number.isFinite(askCents) ||
    askCents <= 0 || askCents > 100) return null;
  const stake = 5;
  return {
    askCents,
    winningProfitBeforeFees: stake / (askCents / 100) - stake,
    breakEvenPercentBeforeFees: askCents,
    maximumLossBeforeFees: stake,
  };
}

/**
 * Markets-first display. No Coinbase price, guessed Chainlink TWAP, heuristic
 * timing score, manual price overrides, or implied positive expected value.
 * Current WaterX indicative asks do NOT guarantee a $5 fill.
 */
export function SimpleLiveDesk({
  interval, now, round, referencePrice, referenceConfirmed, quoteFresh, quoteAtMs, upAsk, downAsk,
}: Props) {
  const active = !!round && Number.isFinite(now) && now >= round.startMs && now < round.expiryMs;
  const ageMs = quoteAtMs == null ? Infinity : now - quoteAtMs;
  const fresh = active && quoteFresh && Number.isFinite(ageMs) && ageMs >= -1000 && ageMs <= 14000;
  const remaining = active && round ? Math.max(0, Math.ceil((round.expiryMs - now) / 1000)) : null;
  const clock = remaining == null ? "—" :
    `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const referenceValid = active && typeof referencePrice === "number" &&
    Number.isFinite(referencePrice) && referencePrice > 0;
  const roundUrl = active && round
    ? `https://waterx.app/en/predict/market/crypto/crypto-btc-updown-${interval}m/${Math.floor(round.expiryMs / 1000)}`
    : null;
  const sides = [
    { side: "UP", ask: upAsk },
    { side: "DOWN", ask: downAsk },
  ] as const;

  return <section className="bw-simple-desk" aria-label="Simple WaterX market overview" data-source={fresh ? "current" : "unavailable"}>
    <header className="bw-simple-header">
      <div>
        <span className="bw-simple-eyebrow">LIVE DESK · WATERX MARKET DATA</span>
        <h2>BTC {interval}m · $5 positions</h2>
      </div>
      <span className={fresh ? "bw-simple-source current" : "bw-simple-source"}>
        {fresh ? `WaterX · ${Math.max(0, Math.floor(ageMs / 1000))}s old` : active ? "Quotes unavailable" : "Awaiting round"}
      </span>
    </header>
    <div className="bw-simple-facts">
      <div><small>Time remaining</small><strong className="bw-simple-clock">{clock}</strong></div>
      <div><small>WaterX price to beat</small>
        <strong>{referenceValid ? dollars(referencePrice!) : "—"}</strong>
        <span className="bw-simple-small">{referenceValid ? referenceConfirmed ? "Provider-confirmed" : "Provisional · not confirmed" : "No valid current-round reference"}</span>
      </div>
    </div>
    <div className="bw-simple-market-label">WaterX indicative purchase prices · updated automatically</div>
    <div className="bw-simple-sides">
      {sides.map(({ side, ask }) => {
        const position = simpleWaterxPosition(ask, fresh);
        return <div className="bw-simple-side" key={side}>
          <div className="bw-simple-side-top"><b>{side}</b><strong>{position ? `${position.askCents.toFixed(1)}¢` : "—"}</strong></div>
          <dl>
            <div><dt>Profit if correct</dt><dd className="bw-simple-profit">{position ? `+${dollars(position.winningProfitBeforeFees)}` : "—"}</dd></div>
            <div><dt>Break-even win rate</dt><dd>{position ? `${position.breakEvenPercentBeforeFees.toFixed(1)}%` : "—"}</dd></div>
          </dl>
        </div>;
      })}
    </div>
    <div className="bw-simple-foot">
      <div><span>Verified prediction edge</span><b>Not established</b></div>
      <p>Outcomes shown before trading fees, slippage, and price impact. A wrong $5 position can lose the full $5 plus costs. Indicative quotes are not executable $5 fills. Coinbase spot is not the WaterX/Chainlink settlement price.</p>
      {roundUrl && <a href={roundUrl} target="_blank" rel="noopener noreferrer">Verify this round on WaterX ↗</a>}
    </div>
  </section>;
}
