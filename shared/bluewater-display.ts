/** Capture-funnel rates from the API are percentage points, not probabilities. */
export function captureRateLabel(value:number|null):string {
  return value!==null&&Number.isFinite(value)&&value>=0&&value<=100?
    `${value.toFixed(1)}%`:"Not reported";
}