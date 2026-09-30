import { runWaterxCandidateTraining } from "../server/waterx/candidate-runtime";

if (!process.env.DATABASE_URL) throw new Error("A configured development database is required.");
const reports = await runWaterxCandidateTraining();
for (const report of reports) {
  console.log(JSON.stringify({
    intervalMinutes: report.intervalMinutes,
    status: report.status,
    datasetFingerprint: report.datasetFingerprint,
    recordCount: report.recordCount,
    acceptedLabelCount: report.acceptedLabelCount,
    rejectionReason: report.rejectionReason,
    promoted: report.promoted,
  }));
}