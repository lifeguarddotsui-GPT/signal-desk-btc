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
}: IndicativeEstimateProps) {
  const spend = amountValid ? money(amountValue) : "Enter a positive amount";
  const gross = (available: boolean, price?: number | null) =>
    quoteCurrent && available && amountValid && price != null
      ? indicativeGross(amountValue, price)
      : null;

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
        <span>Estimated spend before unknown fees</span>
        <strong>{spend}</strong>
      </div>
      <div className="estimate-spend-copy net-unavailable">
        <span>Net profit</span>
        <strong>Unavailable · fees unknown</strong>
      </div>
    </div>
    <div className="estimate-alternatives" aria-label="Alternative side outcomes">
      <div className="estimate-outcome">
        <span>UP · success gross payout</span>
        <strong>{money(gross(upAvailable, upPriceCents))}</strong>
      </div>
      <div className="estimate-outcome">
        <span>DOWN · success gross payout</span>
        <strong>{money(gross(downAvailable, downPriceCents))}</strong>
      </div>
    </div>
    <div className="estimate-foot">
      <span>Quote age · {quoteCurrent ? quoteAge : "not current"}</span>
      <span>Side outcomes are alternatives, not combined.</span>
    </div>
  </section>;
}