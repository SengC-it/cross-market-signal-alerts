import { prepareM3RealData } from "../lib/validation/real-data.js";
import { CONFIG } from "../lib/config.js";

const dataDir = argumentValue("--data-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const manifestPath = argumentValue("--manifest") || "artifacts/m3/manifest.json";
const symbols = argumentValue("--symbols")
  ? argumentValue("--symbols").split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
  : null;
const maxAssets = argumentValue("--max-assets");
const universeFile = argumentValue("--universe-file");
const concurrency = Number(argumentValue("--concurrency") || process.env.M3_REAL_DATA_CONCURRENCY || 4);

try {
  const result = await prepareM3RealData({
    dataDir,
    manifestPath,
    symbols,
    maxAssets: maxAssets == null ? null : Number(maxAssets),
    universeFile,
    concurrency,
    executionModel: {
      marketType: "futures",
      exchangeRulesRequired: true,
      legacyRoundTripCostPct: CONFIG.futuresTradingCost
    },
    onProgress: (progress) => {
      if (progress.phase === "1h" && (progress.error || progress.index === progress.total || progress.index % 10 === 0)) {
        console.error(JSON.stringify(progress));
      }
    }
  });
  console.log(JSON.stringify({
    dataSource: result.index.dataSource,
    dataDir,
    manifestPath: result.manifestPath,
    datasetId: result.manifest.datasetId,
    windowStart: result.manifest.windowStart,
    windowEnd: result.manifest.windowEnd,
    assetCount: result.manifest.assetCount,
    universeSource: result.index.universeSource,
    survivorshipBiasRisk: result.index.survivorshipBiasRisk,
    benchmark: result.manifest.benchmark,
    replayDiagnostics: result.index.replayDiagnostics,
    policyScope: result.index.policyScope,
    fullProductionPolicyValidated: result.index.fullProductionPolicyValidated
  }, null, 2));
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}
