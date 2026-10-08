// Read-only source comparison. Inputs are extracted, pinned public archives;
// no workspace Git history, keys, uploads or database connections are read.
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
const [production,github,output]=process.argv.slice(2);
if(!production||!github||!output)throw new Error("Usage: node scripts/audit-round-history-source.mjs production-directory github-directory output.json");
const hash=b=>createHash("sha256").update(b).digest("hex");
const release=JSON.parse(await readFile(path.join(production,"RELEASE.json"),"utf8"));
const safe=file=>{
  if(typeof file!=="string"||path.isAbsolute(file)||file.split("/").includes(".."))
    throw new Error("Unsafe release path");
  return file;
};
const relevant=file=>/^(server\/waterx\/|shared\/|client\/src\/(?:TwoStage|CanonicalHistory|Timed|ManualOpportunity)|server\/(?:routes|index)\.ts|script\/|scripts\/(?:two-stage|.*settlement|.*waterx|.*timed|.*round))/.test(file);
const changes=[],failedHashes=[];
for(const entry of release.files){
  const file=safe(entry.file),bytes=await readFile(path.join(production,file));
  if(hash(bytes)!==entry.sha256)failedHashes.push(file);
  if(!relevant(file))continue;
  let prior=null;
  try{prior=await readFile(path.join(github,file));}
  catch(error){if(error.code!=="ENOENT")throw error;}
  if(!prior||hash(prior)!==hash(bytes))changes.push({file,status:prior?"MODIFIED":"ADDED",
    githubSha256:prior?hash(prior):null,productionSha256:hash(bytes)});
}
// The GitHub export has a release manifest too. Report relevant removals.
let oldRelease=null;
try{oldRelease=JSON.parse(await readFile(path.join(github,"RELEASE.json"),"utf8"));}
catch(error){if(error.code!=="ENOENT")throw error;}
const currentFiles=new Set(release.files.map(e=>e.file));
for(const entry of oldRelease?.files??[]){
  const file=safe(entry.file);
  if(relevant(file)&&!currentFiles.has(file))changes.push({file,status:"REMOVED",
    githubSha256:entry.sha256,productionSha256:null});
}
if(failedHashes.length)throw new Error(`Production release file hash mismatches: ${failedHashes.join(",")}`);
const report={capturedAt:new Date().toISOString(),productionBuild:release.build,
  githubCommit:"796a787f778a4d52eb13eade7bbca1c1569d18b6",
  githubBuild:oldRelease?.build??null,verifiedProductionFileHashes:release.files.length,
  relevantChanges:changes,note:"Archive bytes compared; public Git history is independent of workspace Git history. Runtime/database/host configuration parity is not asserted."};
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({productionCommit:release.build.sourceCommit,verifiedFiles:release.files.length,
  relevantChangedFiles:changes.length,changedFiles:changes.map(x=>`${x.status} ${x.file}`)},null,2));
