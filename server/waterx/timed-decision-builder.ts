import {randomUUID} from "node:crypto";
import {evaluateTimedDecision,TIMED_STRATEGY,timedPolicy,type TimedRound,type TimedDecision} from "../../shared/timed-decision";
import type {LockObservation} from "../../shared/lock-readiness";
import {observationId} from "./observation-provenance";
import {timedCompletionPolicy} from "../../shared/timed-completion";
import {validWaterxProbabilityPair} from "../../shared/round-decision";
export function buildTimedDecision(round:TimedRound,observations:LockObservation[],discoveredAtMs:number,
  now:number,latestInputValid:boolean,evidence:Record<string,unknown>={},prepareFallback=false):TimedDecision|null{
  const evaluated=evaluateTimedDecision(round,observations,now);
  const before=observations.filter(o=>o.receivedAtMs<=now).slice().sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
  const completion=timedCompletionPolicy(round.intervalMinutes);
  const latest=before.at(-1),hardReached=now>=evaluated.hardDeadlineAtMs;
  const preparing=prepareFallback&&now>=evaluated.hardDeadlineAtMs-completion.allowanceMs;
  const deadline=hardReached||preparing;
  if(now<evaluated.targetAtMs)return null;
  if(!deadline&&(!evaluated.qualified||!latestInputValid))return null;
  const missed=discoveredAtMs>evaluated.hardDeadlineAtMs;
  const sourceValid=!missed&&latestInputValid&&latest&&evaluated.sourceAgeMs!==null&&evaluated.sourceAgeMs<=10000&&
    latest.sourceHealthy&&validWaterxProbabilityPair(latest.probabilityUp,latest.probabilityDown)&&
    latest.receivedAtMs<=evaluated.hardDeadlineAtMs;
  const locked=!!sourceValid;
  // Do not freeze an early NO_VALID_INPUT: new valid evidence may still arrive.
  if(preparing&&!hardReached&&!locked)return null;
  const status=missed?"MISSED_DEADLINE":locked?"LOCKED":"NO_VALID_INPUT";
  const ambiguous=locked&&latest!.probabilityUp===latest!.probabilityDown;
  const maxGap=before.length>1?Math.max(...before.slice(1).map((o,i)=>o.receivedAtMs-before[i].receivedAtMs)):null;
  return {id:randomUUID(),strategyVersion:TIMED_STRATEGY,network:"sui:mainnet",...round,status,
    side:locked?latest!.probabilityUp>=latest!.probabilityDown?"UP":"DOWN":null,
    probabilityUp:locked?latest!.probabilityUp:null,probabilityDown:locked?latest!.probabilityDown:null,
    observationId:locked?observationId(round.intervalMinutes,round.roundId,latest!.receivedAtMs):null,
    receivedAtMs:locked?latest!.receivedAtMs:null,decisionAtMs:now,elapsedMs:now-round.startMs,
    targetAtMs:evaluated.targetAtMs,hardDeadlineAtMs:evaluated.hardDeadlineAtMs,
    lockReason:missed?"COLLECTOR_DISCOVERED_AFTER_HARD_DEADLINE":!locked?
      !latestInputValid?String(evidence.inputFailure??"LATEST_PROBABILITY_INPUT_INVALID"):latest&&latest.receivedAtMs>evaluated.hardDeadlineAtMs?
        "NO_PRE_DEADLINE_SOURCE":evaluated.blocker:
      ambiguous?"DEADLINE_FALLBACK_TIE_BREAK_UP_AMBIGUOUS":deadline?"DEADLINE_FALLBACK":"STABILITY_POLICY_QUALIFIED",
    earlyBlocker:evaluated.blocker,ambiguous,
    coverage:{n:before.length,firstAtMs:before[0]?.receivedAtMs??null,lastAtMs:latest?.receivedAtMs??null,maxGapMs:maxGap},
    committedAtMs:null,workerReceivedAtMs:null,onTime:null,operationalFailure:null,
    automaticExecutionAllowed:false,
    evidence:{...evidence,policy:timedPolicy(round.intervalMinutes),completionPolicy:completion,
      fallbackPreparation:preparing,sourceId:"waterx.public.crypto.v1",providerEventAtMs:null,
      probabilitySemantics:"explicit provider probability pair, not asks",sameTimeWaterxBaseline:locked?
        {probabilityUp:latest!.probabilityUp,probabilityDown:latest!.probabilityDown,side:ambiguous?"UP":
          latest!.probabilityUp>latest!.probabilityDown?"UP":"DOWN"}:null,
      tieBreak:"UP only on exact equal probability; ambiguous and never automatic execution",
      qualifyingConditions:evaluated,deadlineEvaluationLate:now>evaluated.hardDeadlineAtMs}};
}
