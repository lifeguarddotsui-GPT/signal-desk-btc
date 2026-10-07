/** Descriptive calibration of raw market probabilities, not qualified model confidence. */
export function forecastMetrics(rows:{probability:number;outcome:string}[]){
  const valid=rows.filter(r=>Number.isFinite(r.probability)&&r.probability>=0&&r.probability<=1&&["UP","DOWN"].includes(r.outcome));
  const bins=Array.from({length:10},(_,i)=>({from:i/10,to:(i+1)/10,n:0,p:0,y:0}));
  let brier=0,logLoss=0,correct=0;
  for(const r of valid){
    const y=Number(r.outcome==="UP"),p=r.probability,clipped=Math.max(1e-10,Math.min(1-1e-10,p));
    brier+=(p-y)**2;logLoss-=y*Math.log(clipped)+(1-y)*Math.log(1-clipped);correct+=Number((p>.5)===(y===1));
    const b=bins[Math.min(9,Math.floor(p*10))];b.n++;b.p+=p;b.y+=y;
  }
  const calibration=bins.filter(b=>b.n).map(b=>({from:b.from,to:b.to,n:b.n,meanProbability:b.p/b.n,observedUpRate:b.y/b.n}));
  return {n:valid.length,accuracy:valid.length?correct/valid.length:null,brier:valid.length?brier/valid.length:null,
    logLoss:valid.length?logLoss/valid.length:null,calibration,ece:valid.length?
      calibration.reduce((s,b)=>s+b.n/valid.length*Math.abs(b.meanProbability-b.observedUpRate),0):null};
}
