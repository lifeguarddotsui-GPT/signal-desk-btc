import {createHash} from "node:crypto";
export function observationId(interval:number,roundId:string,receivedAtMs:number){
  return createHash("sha256").update(`waterx.public.crypto.v1:sui:mainnet:${interval}:${roundId}:${receivedAtMs}`).digest("hex");
}
