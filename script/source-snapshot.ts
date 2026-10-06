import {mkdtemp,readdir,readFile,lstat,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";

// Source-only export, never Git history, uploads, runtime data, reports or env files.
const roots=["server","shared","client/src","script","scripts","migrations","edge","infrastructure"];
const configs=["package.json","package-lock.json","tsconfig.json","vite.config.ts",
  "client/index.html","client/public/favicon.svg","client/public/favicon-mono.svg"];
export function allowedSourcePath(file:string){
  return configs.includes(file)||roots.some(root=>file.startsWith(root+"/"))&&
    /\.(?:ts|tsx|mjs|js|css|sql|toml)$/.test(file)&&!file.split("/").some(part=>
      part.startsWith(".")||["node_modules","attached_assets","backups","reports","dist"].includes(part));
}
export async function sourceSnapshot(){
  const files=[...configs];
  async function walk(dir:string){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const file=dir+"/"+entry.name;
      if(entry.isSymbolicLink())throw new Error(`Source export rejects symlink: ${file}`);
      if(entry.isDirectory()&&!entry.name.startsWith("."))await walk(file);
      else if(entry.isFile()&&allowedSourcePath(file))files.push(file);
    }
  }
  for(const root of roots)await walk(root);
  const entries=[];
  for(const file of [...new Set(files)].sort()){
    if((await lstat(file)).isSymbolicLink())throw new Error("Source config cannot be a symlink");
    const content=await readFile(file);
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{32,}/.test(content.toString()))
      throw new Error(`Credential-shaped material in source export: ${file}`);
    entries.push({file,content,sha256:createHash("sha256").update(content).digest("hex")});
  }
  const digest=createHash("sha256").update(entries.map(e=>e.file+"\0"+e.sha256+"\0").join("")).digest("hex");
  return {entries,digest};
}
export async function packageSource(snapshot:Awaited<ReturnType<typeof sourceSnapshot>>,build:Record<string,unknown>){
  const dir=await mkdtemp(join(tmpdir(),"bluewater-reviewed-source-"));
  try{
    for(const entry of snapshot.entries){
      const destination=join(dir,entry.file);
      await mkdir(dirname(destination),{recursive:true});await writeFile(destination,entry.content);
    }
    await writeFile(join(dir,"RELEASE.json"),JSON.stringify({build,sourceDigest:snapshot.digest,
      scope:"Source-only current release. No workspace Git history, uploads, runtime keys or database data.",
      files:snapshot.entries.map(({file,sha256})=>({file,sha256}))},null,2));
    const destination="dist/public/source-release.tar.gz";
    execFileSync("tar",["--sort=name","--mtime=@0","--owner=0","--group=0","--numeric-owner",
      "-czf",destination,"-C",dir,"."]);
    return createHash("sha256").update(await readFile(destination)).digest("hex");
  }finally{await rm(dir,{recursive:true,force:true});}
}
