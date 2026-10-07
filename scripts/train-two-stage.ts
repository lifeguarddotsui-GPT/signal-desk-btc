import {runTwoStageLearning} from "../server/waterx/two-stage-learning";
try{for(const interval of [5,15] as const){const report=await runTwoStageLearning(interval);
  console.log(JSON.stringify({interval,report},null,2));}process.exit(0);}
catch(error){console.error(error instanceof Error?error.message:"Two-stage learning failed");process.exit(1);}
