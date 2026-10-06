/** HTML axis rows keep clock ticks separate from round-boundary captions.
 * Tick capacity is based on measured plot width, including enlarged root text.
 * End ticks are aligned inward, so neither can cross the chart/sidebar edge. */
export function chartTimeAxis(start:number,end:number,plotWidth:number,textScale=1){
  const scale=Number.isFinite(textScale)&&textScale>0?textScale:1;
  const n=Math.max(2,Math.min(6,Math.floor(Math.max(0,plotWidth)/(78*scale))+1));
  return Array.from({length:n},(_,index)=>{
    const fraction=index/(n-1),at=start+fraction*(end-start);
    return {at,fraction,align:index===0?"left" as const:index===n-1?"right" as const:"center" as const,
      label:new Date(at).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})};
  });
}
