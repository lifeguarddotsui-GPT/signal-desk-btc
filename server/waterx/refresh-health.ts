import type {WaterxInterval} from "./types";
export type RefreshStage="PROVIDER_REQUEST"|"PROVIDER_RESPONSE"|"PARSE_VALIDATION"|"IDENTITY_VALIDATION"|
  "READINESS_EVALUATION"|"DATABASE_QUEUE"|"DATABASE_WRITE"|"DATABASE_COMMIT"|"PUBLICATION"|
  "REQUEST_START"|"BROWSER_RECEIPT"|"BROWSER_RENDER"|"CAPTURE_RESULT"|"READINESS_INPUT"|
  "EARLY_DATABASE_WRITE"|"OBSERVATION_DATABASE_WRITE"|"EARLY_INPUT_VALIDATION";
export type RefreshEvent={interval:WaterxInterval;stage:RefreshStage;roundId?:string|null;
  outcome:"started"|"ok"|"error";elapsedMs?:number;retryCount?:number;sourceAgeMs?:number|null;
  queueDepth?:number;queueAgeMs?:number|null;errorClass?:string|null;clock?:"server"|"browser-untrusted"};
export function refreshErrorClass(error:unknown):string {
  const code=(error as {code?:unknown})?.code;
  if(typeof code==="string"&&/^[A-Z0-9_]{2,30}$/.test(code))return code;
  const message=error instanceof Error?error.message:"";
  if(/timeout|timed out/i.test(message))return "TIMEOUT";
  if(/connection terminated|disconnect|reset|socket/i.test(message))return "CONNECTION_FAILURE";
  if(/invalid|mismatch|cadence|malformed|identity/i.test(message))return "INVALID_INPUT";
  return "OPERATION_FAILED";
}
export function createRefreshHealth(clock=Date.now){
  const events=new Map<WaterxInterval,(RefreshEvent&{atMs:number})[]>();
  const states=new Map<string,{stage:RefreshStage;failures:number;lastErrorClass:string|null;atMs:number}>();
  return {
    record(event:RefreshEvent){
      const atMs=clock(),list=events.get(event.interval)??[];
      // Deliberately project fields: never keep errors, query text, request bodies, addresses or credentials.
      const safe:RefreshEvent&{atMs:number}={atMs,interval:event.interval,stage:event.stage,
        roundId:event.roundId??null,outcome:event.outcome,elapsedMs:event.elapsedMs,
        retryCount:event.retryCount,sourceAgeMs:event.sourceAgeMs,queueDepth:event.queueDepth,
        queueAgeMs:event.queueAgeMs,errorClass:event.errorClass??null,clock:event.clock??"server"};
      list.push(safe);events.set(event.interval,list.slice(-128));
      if(safe.clock==="browser-untrusted")return;
      const key=`${event.interval}:${event.stage}`,old=states.get(key);
      if(event.outcome==="error")states.set(key,{stage:event.stage,failures:(old?.failures??0)+1,
        lastErrorClass:event.errorClass??"OPERATION_FAILED",atMs});
      if(event.outcome==="ok")states.delete(key);
    },
    read(interval:WaterxInterval){
      const errors=Array.from(states.entries()).filter(([key])=>key.startsWith(`${interval}:`)).map(([,state])=>({...state}));
      return {scope:"process-memory; resets on restart",browserTiming:"untrusted browser-relative diagnostics, not execution evidence",
        errors,alerts:errors.filter(e=>e.failures>=2).map(e=>`${e.stage}: ${e.failures} repeated failures (${e.lastErrorClass})`),
        events:(events.get(interval)??[]).map(e=>({...e}))};
    },
  };
}
export const refreshHealth=createRefreshHealth();
