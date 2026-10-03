import { Transaction } from "@mysten/sui/transactions";
type Data = ReturnType<Transaction["getData"]>;
function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value)
    .filter(([key])=>key!=="$kind").sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));
  return value;
}
function inputIdentity(input: Data["inputs"][number]): unknown {
  if(input.$kind==="Pure")return {pure:input.Pure.bytes};
  if(input.$kind==="UnresolvedObject")return {object:input.UnresolvedObject.objectId};
  if(input.$kind==="Object"){
    const o=input.Object;
    if(o.$kind==="ImmOrOwnedObject")return {object:o.ImmOrOwnedObject.objectId};
    if(o.$kind==="SharedObject")return {object:o.SharedObject.objectId};
    if(o.$kind==="Receiving")return {object:o.Receiving.objectId};
  }
  return {unsupported:true};
}
/** Ignore only wallet-selected gas/expiration and resolved object versions.
 * Commands, argument references, pure bytes, object IDs and sender must match.
 */
export function matchesOwnerIntent(prepared: Data, actual: Data): boolean {
  if(prepared.sender!==actual.sender||prepared.inputs.length!==actual.inputs.length)return false;
  const p=prepared.inputs.map(inputIdentity),a=actual.inputs.map(inputIdentity);
  if(p.some(i=>(i as {unsupported?:boolean}).unsupported)||a.some(i=>(i as {unsupported?:boolean}).unsupported))return false;
  return JSON.stringify(canonical(p))===JSON.stringify(canonical(a))&&
    JSON.stringify(canonical(prepared.commands))===JSON.stringify(canonical(actual.commands));
}