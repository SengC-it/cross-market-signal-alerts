import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadM37Data,
  loadM37Dataset
} from "../lib/validation/m3-7-data.js";
import { researchDataQualityGate } from "../lib/validation/m3-7-research.js";

const effectiveCoverage = {
  providerGapPolicyFrozen: true,
  researchEffectiveDataQualityComplete: true,
  unhandledProviderGapDependencies: 0,
  requiredHistoricalFundingAvailable: true,
  signalRelevantFundingCoverage: { complete: true },
  signalRelevantLowerTfCoverage: { complete: true },
  nonProviderCrossSectionalIncompleteTimestamps: 0,
  researchDataQualityComplete: false
};
const effectiveGate = researchDataQualityGate({
  dataCoverage: effectiveCoverage,
  historicalUniverseComplete: true
});
assert.equal(effectiveGate.complete, true);
assert.equal(effectiveGate.checks.researchEffectiveDataQualityComplete, true);
assert.equal(effectiveGate.checks.providerGapPolicyFrozen, true);
assert.equal(researchDataQualityGate({
  dataCoverage: { ...effectiveCoverage, providerGapPolicyFrozen: false },
  historicalUniverseComplete: true
}).complete, false);
assert.equal(researchDataQualityGate({
  dataCoverage: { ...effectiveCoverage, unhandledProviderGapDependencies: 1 },
  historicalUniverseComplete: true
}).complete, false);
assert.equal(researchDataQualityGate({
  dataCoverage: { ...effectiveCoverage, unhandledProviderGapDependencies: null },
  historicalUniverseComplete: true
}).complete, false);
assert.equal(researchDataQualityGate({
  dataCoverage: { ...effectiveCoverage, nonProviderCrossSectionalIncompleteTimestamps: null },
  historicalUniverseComplete: true
}).complete, false);

const root = await mkdtemp(join(tmpdir(), "m3-7-readiness-"));
try {
  await mkdir(join(root, "datasets"), { recursive: true });
  const descriptor = { asset: "TESTUSDT", path: "datasets/TESTUSDT.json" };
  const fullDataset = {
    asset: "TESTUSDT",
    candles: [{ openTime: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 }],
    lowerTimeframe: "5m",
    lowerTimeframeCandles: [{ openTime: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }],
    lowerTimeframeCoverage: { status: "COMPLETE", complete: true },
    fundingEvents: [],
    fundingCoverage: { status: "COMPLETE", complete: true }
  };
  await writeFile(join(root, "index.json"), JSON.stringify({
    datasets: [descriptor],
    benchmarkCandles: []
  }));
  await writeFile(join(root, descriptor.path), JSON.stringify(fullDataset));

  const lightweight = await loadM37Data({ dataDir: root });
  assert.deepEqual(lightweight.datasetDescriptors, [descriptor]);
  assert.equal(lightweight.datasets.length, 1);
  assert.equal(Object.hasOwn(lightweight.datasets[0], "lowerTimeframeCandles"), false);

  const loadedFull = await loadM37Dataset({ dataDir: root, descriptor });
  assert.equal(loadedFull.lowerTimeframeCandles.length, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  test: "m3-7-readiness",
  passed: true,
  effectiveQualityGate: true,
  rawQualityGate: false,
  defaultLoaderExcludesLowerTimeframe: true
}, null, 2));
