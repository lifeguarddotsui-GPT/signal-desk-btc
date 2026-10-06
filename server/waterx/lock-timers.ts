import { lockPolicy } from "../../shared/lock-readiness";
import type { LockRound } from "./lock-store";

/** One exact round per interval; deadlines request a fresh read, never lock cached odds. */
export function createLockTimers(read:(interval:5|15)=>Promise<unknown>,
  options:{now?:()=>number;schedule?:typeof setTimeout;cancel?:typeof clearTimeout}={}) {
  const now=options.now??Date.now,schedule=options.schedule??setTimeout,cancel=options.cancel??clearTimeout;
  const rounds=new Map<number,string>(),timers=new Map<number,ReturnType<typeof setTimeout>[]>();
  const stopInterval=(interval:number)=>{for(const t of timers.get(interval)??[])cancel(t);timers.delete(interval);};
  return {
    arm(round:LockRound) {
      const identity=`${round.roundId}:${round.startMs}:${round.expiryMs}`;
      if(rounds.get(round.intervalMinutes)===identity)return;
      stopInterval(round.intervalMinutes);rounds.set(round.intervalMinutes,identity);
      const pending:ReturnType<typeof setTimeout>[]=[];
      // Lead read reduces provider delay; exact and +2s reads remain bounded by normal coalescing.
      for(const seconds of lockPolicy(round.intervalMinutes).windows)for(const offset of [-1500,0,2000]){
        const at=round.expiryMs-seconds*1000+offset;
        if(at<=now()||at>=round.expiryMs)continue;
        const t=schedule(()=>{if(rounds.get(round.intervalMinutes)===identity)
          void read(round.intervalMinutes).catch(()=>{});},at-now());
        t.unref?.();pending.push(t);
      }
      timers.set(round.intervalMinutes,pending);
    },
    stop(){for(const interval of Array.from(timers.keys()))stopInterval(interval);rounds.clear();},
  };
}