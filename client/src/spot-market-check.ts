/** Cross-source context is a consistency warning, NOT a translation from
 * market probability into a current or settlement oracle price.
 */
export type SpotMarketCheck={
  marketFavor:"UP"|"DOWN"|"NEUTRAL"|null;
  spotSide:"ABOVE"|"BELOW"|"AT"|null;
  differentIndicators:boolean;
  priceDifferenceUsd:number|null;
  label:string;
};
export function spotMarketCheck(args:{
  spot:number|null;reference:number|null;
  upProbability:number|null;downProbability:number|null;
  priceFresh:boolean;oddsFresh:boolean;marketThreshold?:number;
}):SpotMarketCheck{
  const {spot,reference,upProbability,downProbability,priceFresh,oddsFresh}=args;
  const threshold=args.marketThreshold??.6;
  const spotValid=priceFresh&&spot!=null&&reference!=null&&
    Number.isFinite(spot)&&Number.isFinite(reference)&&spot>0&&reference>0;
  const priceDifferenceUsd=spotValid?spot!-reference!:null;
  const spotSide=priceDifferenceUsd==null?null:
    Math.abs(priceDifferenceUsd)<.005?"AT":priceDifferenceUsd>0?"ABOVE":"BELOW";
  const oddsValid=oddsFresh&&upProbability!=null&&downProbability!=null&&
    Number.isFinite(upProbability)&&Number.isFinite(downProbability)&&
    upProbability>=0&&upProbability<=1&&downProbability>=0&&downProbability<=1&&
    Math.abs(upProbability+downProbability-1)<=.02;
  const marketFavor=oddsValid?
    upProbability!>=threshold?"UP":downProbability!>=threshold?"DOWN":"NEUTRAL":null;
  const differentIndicators=(spotSide==="BELOW"&&marketFavor==="UP")||
    (spotSide==="ABOVE"&&marketFavor==="DOWN");
  const marketDescription=marketFavor==="UP"?"Market pricing favors UP":
    marketFavor==="DOWN"?"Market pricing favors DOWN":
    marketFavor==="NEUTRAL"?"Market roughly balanced":"WaterX market odds unavailable";
  const spotDescription=spotSide==="BELOW"?"Coinbase below reference":
    spotSide==="ABOVE"?"Coinbase above reference":
    spotSide==="AT"?"Coinbase near reference":"Coinbase comparison unavailable";
  return{marketFavor,spotSide,differentIndicators,priceDifferenceUsd,
    label:`${marketDescription} · ${spotDescription}${differentIndicators?" · different indicators":""}`};
}
