import { indicativeGross } from "./waterx-ui-contract";

type IndicativeEstimateProps = {
  amount: string;
  amountValue: number;
  amountValid: boolean;
  onAmountChange: (value: string) => void;
  quoteCurrent: boolean;
  quoteAge: string;
  upAvailable: boolean;
  upPriceCents: number | null | undefined;
  downAvailable: boolean;
  downPriceCents: number | null | undefined;
  fixtureMode: boolean;
  advisory: {
    up: { quote: IndicativeSideQuote };
    down: { quote: IndicativeSideQuote };
  } | null;
};

type IndicativeSideQuote = {
  grossReceiptIfWinIndicative?: number | null;
  breakEvenProbabilityBeforeFeesIndicative?: number | null;
  lossIfUnsuccessfulBeforeFeesIndicative?: number | null;
};

const money = (value: number | null) => value == null || !Number.isFinite(value)
  ? "Unavailable"
  : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function IndicativeEstimate({
  amount,
  amountValue,
  amountValid,
  onAmountChange,
  quoteCurrent,
  quoteAge,
  upAvailable,
  upPriceCents,
  downAvailable,
  downPriceCents,
  fixtureMode,
  advisory,
}: IndicativeEstimateProps) {
  const spend = amountValid ? money(amountValue) : "Enter a positive amount";
  const gross = (side: "up" | "down", available: boolean, price?: number | null) =>
    quoteCurrent && available && amountValid
      ? fixtureMode && price != null
        ? indicativeGross(amountValue, price)
        : advisory?.[side].quote.grossReceiptIfWinIndicative ?? null
      : null;
  const breakEven = (side: "up" | "down", available: boolean, price?: number | null) => {
    if (!quoteCurrent || !available || !amountValid) return null;
    return fixtureMode && price != null ? price / 100
      : advisory?.[side].quote.breakEvenProbabilityBeforeFeesIndicative ?? null;
  };
  const percent = (value: number | null) => value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;

  return <section className="five-dollar-summary estimate-panel" aria-label="Hypothetical market estimate">
    <div className="estimate-topline">
      <strong>Hypothetical spend estimate</strong>
      <span className="estimate-status">INDICATIVE · NON-EXECUTABLE</span>
    </div>
    <div className="estimate-input-row">
      <label className="estimate-spend" htmlFor="indicative-amount">
        <span>Entered amount</span>
        <span className="estimate-input"><span>$</span><input id="indicative-amount" aria-label="Hypothetical spend amount in dollars" type="number" min="0.01" step="0.01" value={amount} onChange={event => onAmountChange(event.target.value)} /></span>
      </label>
      <div className="estimate-spend-copy">
        <span>Risk / spend before unknown fees</span>
        <strong>{spend}</strong>
      </div>
      <div className="estimate-spend-copy net-unavailable">
        <span>Net profit if successful / estimated net value</span>
        <strong>Unavailable · fees unknown</strong>
      </div>
    </div>
    <div className="estimate-alternatives" aria-label="Alternative side outcomes">
      <div className="estimate-outcome">
        <span>UP · success gross payout</span>
        <strong>{money(gross("up", upAvailable, upPriceCents))}</strong>
        <small>Break-even before fees {percent(breakEven("up", upAvailable, upPriceCents))}</small>
      </div>
      <div className="estimate-outcome">
        <span>DOWN · success gross payout</span>
        <strong>{money(gross("down", downAvailable, downPriceCents))}</strong>
        <small>Break-even before fees {percent(breakEven("down", downAvailable, downPriceCents))}</small>
      </div>
    </div>
    <div className="estimate-foot">
      <span>Quote age · {quoteCurrent ? quoteAge : "not current"}</span>
      <span>Side outcomes are alternatives, not combined. Losing a binary position could cost the stake; refunds and fees are unverified.</span>
    </div>
  </section>;
}