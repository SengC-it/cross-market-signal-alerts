import { prepareM37Data } from "../lib/validation/m3-7-data.js";

const sourceDir = argumentValue("--source-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const dataDir = argumentValue("--data-dir") || process.env.M3_7_DATA_DIR || ".local/m3-7-data";
const network = !process.argv.includes("--offline");
const concurrency = Number(argumentValue("--concurrency") || process.env.M3_7_DATA_CONCURRENCY || 2);

try {
  const result = await prepareM37Data({
    sourceDir,
    dataDir,
    network,
    concurrency,
    onProgress(progress) {
      if (progress.phase === "funding" && (progress.index === progress.total || progress.index % 25 === 0)) {
        console.error(JSON.stringify(progress));
      }
      if (progress.phase === "5m" && (progress.index === progress.total || progress.index % 25 === 0)) {
        console.error(JSON.stringify(progress));
      }
    }
  });
  console.log(JSON.stringify({
    dataDir,
    datasetId: result.index.datasetId,
    preparationStatus: result.index.preparationStatus,
    candidateDefinitionsHash: result.index.candidateDefinitionsHash,
    signalCounts: result.index.signalCounts,
    fundingEvaluation: result.index.fundingEvaluation,
    dataCoverage: result.index.dataCoverage
  }, null, 2));
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}
