import test from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@mysten/sui/transactions";
import { matchesOwnerIntent } from "../server/agent/intent";
const make=()=>{
  const tx=new Transaction();tx.setSender("0x1");
  tx.moveCall({target:"0x2::test::owner_op",arguments:[tx.object("0x3"),tx.pure.u64(10)]});return tx;
};
test("owner confirmation matches exact commands, pure amounts and object IDs, not just target",()=>{
  const data=make().getData();assert.equal(matchesOwnerIntent(data,data),true);
  const amount=make();amount.moveCall({target:"0x2::test::extra"});assert.equal(matchesOwnerIntent(data,amount.getData()),false);
  const foreign=make();foreign.setSender("0x4");assert.equal(matchesOwnerIntent(data,foreign.getData()),false);
  const other=new Transaction();other.setSender("0x1");other.moveCall({target:"0x2::test::owner_op",arguments:[other.object("0x3"),other.pure.u64(11)]});
  assert.equal(matchesOwnerIntent(data,other.getData()),false);
});