/** OFFLINE ONLY: never runs as part of the website or a background collector.
 * Import a separately verified collection of real WaterX receipts with matching
 * public chain/WaterX settlement TWAP evidence. No network access, secrets,
 * database mutations, or trading decisions.
 */
import {readFileSync} from "node:fs";
import {researchVerifiedFills,type EntryFillEvidence} from "../server/waterx/filled-entry-training";
const file=process.argv[2],limit=2_000_000;
if(!file){console.error("Usage: node --import tsx scripts/train-filled-entry-timing.ts /path/to/verified-fills.json");process.exit(2);}
try{
  const bytes=readFileSync(file);
  if(bytes.length>limit)throw new Error("Input exceeds 2MB limit");
  const raw:unknown=JSON.parse(bytes.toString("utf8"));
  if(!Array.isArray(raw)||raw.length>10000)throw new Error("Expected JSON array of at most 10,000 externally reconciled filled receipts");
  const now=Date.now();
  for(const interval of [5,15] as const){
    const report=researchVerifiedFills(raw as EntryFillEvidence[],interval,now);
    console.log(JSON.stringify(report,null,2));
  }
  console.warn("IMPORTANT: assertions in imported proof records are not cryptographic verification. Reports are observational and NEVER promote models or authorize trades.");
}catch(err){console.error("Entry research failed:",err instanceof Error?err.message:"Unknown error");process.exitCode=1;}
