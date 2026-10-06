/** For idempotent database operations only. Never use this for chain submissions. */
export function transientDatabaseError(error:unknown):boolean{
  const code=(error as {code?:unknown})?.code;
  if(typeof code==="string"&&(/^(08|53)/.test(code)||["57014","57P01","57P02","57P03","ECONNRESET","ETIMEDOUT"].includes(code)))return true;
  return error instanceof Error&&/query read timeout|connection timeout|timeout exceeded when trying to connect|connection terminated unexpectedly/i.test(error.message);
}
export async function boundedDatabaseRetry<T>(operation:(attempt:number)=>Promise<T>,options:{
  canRetry:()=>boolean;onFailure?:(error:unknown,attempt:number)=>void;
  sleep?:(ms:number)=>Promise<void>;random?:()=>number;
}):Promise<T>{
  const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  for(let attempt=0;;attempt++){
    try{return await operation(attempt);}
    catch(error){
      options.onFailure?.(error,attempt);
      if(attempt>=2||!transientDatabaseError(error)||!options.canRetry())throw error;
      await sleep(300*2**attempt+Math.floor((options.random??Math.random)()*200));
      // Do not retry after expiry or after the ORIGINAL input has become stale.
      if(!options.canRetry())throw error;
    }
  }
}
