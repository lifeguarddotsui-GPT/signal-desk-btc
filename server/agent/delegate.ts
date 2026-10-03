import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { randomBytes } from "node:crypto";
type DisposableDelegate = { address:string; reference:string; createdAtMs:number };
// Development-only disposable identities. Never serialize a key to DB/logs/API.
// No exported signing function: LIVE requires a reviewed external signer service.
const identities = new Map<string,{key:Ed25519Keypair;metadata:DisposableDelegate}>();
export function developmentDelegate(owner:string,network:string): DisposableDelegate {
  if(process.env.NODE_ENV!=="development"||network!=="testnet")throw new Error("Disposable delegate is testnet/development only");
  let item=identities.get(owner);
  if(!item){
    const key=Ed25519Keypair.generate();
    item={key,metadata:{address:key.toSuiAddress(),reference:`disposable-process:${randomBytes(16).toString("hex")}`,createdAtMs:Date.now()}};
    identities.set(owner,item);
  }
  return {...item.metadata};
}