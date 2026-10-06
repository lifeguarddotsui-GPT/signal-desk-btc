import {useCallback,useEffect,useRef,useState} from "react";
import {validateDecisionSnapshot,validateLiveEnvelope,type LiveSnapshotEnvelope} from "./live-decision-contract";

export const snapshotRetryDelay=(attempt:number,random=Math.random)=>Math.min(2500,300*2**attempt)+Math.floor(random()*200);
export const transientSnapshotFailure=(code:string)=>/^(NETWORK_ERROR|REQUEST_TIMEOUT|HTTP_(408|429|500|502|503|504))$/.test(code);
type RefreshStage="REQUEST_START"|"BROWSER_RECEIPT"|"BROWSER_RENDER";
function clientEvent(interval:5|15,stage:RefreshStage,attempt:number,elapsedMs:number,payload?:LiveSnapshotEnvelope){
  if(!payload?.round||!payload.decision)return;
  // Strict, address-free fields only. Server treats browser clocks as untrusted diagnostics.
  void fetch("/api/waterx/decision-client-event",{method:"POST",headers:{"Content-Type":"application/json"},
    credentials:"omit",body:JSON.stringify({interval,stage,attempt,elapsedMs:Math.max(0,elapsedMs),
      roundId:payload.round.id,streamId:payload.decision.streamId,stateVersion:payload.decision.stateVersion}),
    keepalive:true}).catch(()=>{});
}
export function useLiveSnapshot<T extends LiveSnapshotEnvelope>(url:string,interval:5|15,enabled=true,refreshMs=3000){
  const [data,setData]=useState<T|null>(null),[atomicData,setAtomicData]=useState<T|null>(null);
  const [error,setError]=useState(""),[errorUrl,setErrorUrl]=useState("");
  const [loading,setLoading]=useState(true),[updated,setUpdated]=useState(0),[atomicUpdated,setAtomicUpdated]=useState(0);
  const [loadedUrl,setLoadedUrl]=useState(""),[atomicLoadedUrl,setAtomicLoadedUrl]=useState("");
  const [nonce,setNonce]=useState(0),[retryCount,setRetryCount]=useState(0),[failureCount,setFailureCount]=useState(0);
  const last=useRef<{url:string;data:T|null;atomic:T|null}>({url:"",data:null,atomic:null});
  const generation=useRef(0);
  const reload=useCallback(()=>setNonce(n=>n+1),[]);
  useEffect(()=>{
    const id=++generation.current,owner=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const active=()=>!owner.signal.aborted&&generation.current===id;
    if(last.current.url!==url){
      last.current={url,data:null,atomic:null};setData(null);setAtomicData(null);setUpdated(0);setAtomicUpdated(0);
      setError("");setErrorUrl("");setFailureCount(0);setRetryCount(0);
    }
    if(!enabled){setLoading(false);setData(null);setAtomicData(null);return()=>owner.abort();}
    const sleep=(ms:number)=>new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(t);owner.signal.removeEventListener("abort",done);resolve();};
      const t=setTimeout(done,ms);owner.signal.addEventListener("abort",done,{once:true});
    });
    async function refresh(){
      if(!active())return;
      setLoading(true);
      for(let attempt=0;attempt<3&&active();attempt++){
        const started=performance.now(),request=new AbortController();
        let timedOut=false;
        const cancel=()=>request.abort();owner.signal.addEventListener("abort",cancel,{once:true});
        const timeout=setTimeout(()=>{timedOut=true;request.abort();},7500);
        clientEvent(interval,"REQUEST_START",attempt,0,last.current.atomic??undefined);
        try{
          const response=await fetch(url,{signal:request.signal,cache:"no-store"});
          if(!response.ok)throw new Error(`HTTP_${response.status}`);
          const parsed:unknown=await response.json();
          if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("INVALID_RESPONSE");
          const incoming=parsed as T;
          const envelopeError=validateLiveEnvelope(incoming,interval,last.current.data);
          if(envelopeError)throw new Error(envelopeError);
          if(!active())return;
          const decisionError=incoming.decision
            ?validateDecisionSnapshot(incoming,interval,last.current.atomic):null;
          if(decisionError&&["STATE_VERSION_REGRESSION","SOURCE_OBSERVATION_REGRESSION",
            "IMMUTABLE_CHOICE_REGRESSION","IMMUTABLE_EARLY_DECISION_REGRESSION",
            "IMMUTABLE_TIMED_DECISION_REGRESSION"].includes(decisionError))
            throw new Error(decisionError);
          const receivedAt=Date.now();
          last.current.data=incoming;setData(incoming);setUpdated(receivedAt);setLoadedUrl(url);
          if(decisionError)throw new Error(decisionError);
          last.current.atomic=incoming;setAtomicData(incoming);setAtomicUpdated(receivedAt);setAtomicLoadedUrl(url);
          setError("");setErrorUrl("");setFailureCount(0);setRetryCount(attempt);
          clientEvent(interval,"BROWSER_RECEIPT",attempt,performance.now()-started,incoming);
          break;
        }catch(failure){
          if(!active())return;
          const code=timedOut?"REQUEST_TIMEOUT":failure instanceof TypeError?"NETWORK_ERROR":
            failure instanceof SyntaxError?"RESPONSE_PARSE_ERROR":
            failure instanceof Error&&/^[A-Z_0-9]{1,80}$/.test(failure.message)?failure.message:"INVALID_RESPONSE";
          setError(code);setErrorUrl(url);setRetryCount(attempt);setFailureCount(n=>n+1);
          // Retain the last exact-round snapshot. The common view expires its live fields at 10s.
          if(attempt===2||!transientSnapshotFailure(code))break;
          await sleep(snapshotRetryDelay(attempt));
        }finally{
          clearTimeout(timeout);owner.signal.removeEventListener("abort",cancel);
        }
      }
      if(active()){setLoading(false);timer=setTimeout(()=>void refresh(),refreshMs);}
    }
    void refresh();
    return()=>{owner.abort();if(timer)clearTimeout(timer);};
  },[url,interval,enabled,refreshMs,nonce]);
  useEffect(()=>{
    if(!atomicData?.decision)return;
    const start=performance.now();
    const frame=requestAnimationFrame(()=>clientEvent(interval,"BROWSER_RENDER",retryCount,performance.now()-start,atomicData));
    return()=>cancelAnimationFrame(frame);
  },[atomicData,interval,retryCount]);
  return {data,atomicData,error,errorUrl,loading,updated,atomicUpdated,loadedUrl,atomicLoadedUrl,
    reload,retryCount,failureCount};
}
