import {runEarlyDailyTraining} from "../server/waterx/early-training";
import {researchPool} from "../server/waterx/research-store";
try{
  await runEarlyDailyTraining(Date.now(),researchPool,process.argv.includes("--retry-failed"));
  console.log("Early-horizon daily invocation finished; existing attempts may be skipped. Persisted jobs are authoritative for status/results.");
}catch(error){
  console.error("Early-horizon daily evaluation failed",error instanceof Error?error.message:"unknown");
  process.exitCode=1;
}finally{await researchPool.end();}
