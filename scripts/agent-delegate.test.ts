import test from "node:test";
import assert from "node:assert/strict";
import { developmentDelegate } from "../server/agent/delegate";
test("disposable testnet delegate is owner-isolated and API metadata cannot expose keys",()=>{
  const previous=process.env.NODE_ENV;process.env.NODE_ENV="development";
  try{
    const a=developmentDelegate("fixture-owner-a","testnet"),b=developmentDelegate("fixture-owner-b","testnet");
    assert.notEqual(a.address,b.address);assert.deepEqual(developmentDelegate("fixture-owner-a","testnet"),a);
    assert.deepEqual(Object.keys(a).sort(),["address","createdAtMs","reference"]);
    assert.doesNotMatch(JSON.stringify(a),/privateKey|secretKey|seedPhrase/);
    assert.throws(()=>developmentDelegate("fixture-owner-a","mainnet"),/testnet/);
    process.env.NODE_ENV="production";assert.throws(()=>developmentDelegate("fixture-owner-a","testnet"),/development/);
  }finally{process.env.NODE_ENV=previous;}
});