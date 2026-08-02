import { readdir, readFile, writeFile } from "node:fs/promises";

const PRICE_ROOT = process.env.FUNDING_CARRY_V2_VISION_ROOT || ".backtest-cache/binance-vision-futures-1h";
const FUNDING_ROOT = process.env.FUNDING_CARRY_V2_FUNDING_CACHE || ".backtest-cache/v3-2-funding";
const OUTPUT_FILE = process.env.FUNDING_CARRY_V2_UNIVERSE_OUTPUT || "funding_carry_v2_universe_2026-08-02.json";
const START = Date.parse("2023-01-01T00:00:00Z");
const END = Date.parse("2025-01-01T00:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const EXPECTED_HOURS = (END - START) / HOUR_MS;
const MIN_COVERAGE = Number(process.env.FUNDING_CARRY_V2_MIN_TRAIN_COVERAGE || 0.95);
const MIN_FUNDING_COVERAGE = Number(process.env.FUNDING_CARRY_V2_MIN_FUNDING_COVERAGE || 0.95);
const TARGET_SIZE = Number(process.env.FUNDING_CARRY_V2_UNIVERSE_SIZE || 50);
const EXCLUDED_SYMBOLS = new Set((process.env.FUNDING_CARRY_V2_EXCLUDE_SYMBOLS || "")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean));

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line || line.startsWith("open_time,")) continue;
    const fields = line.split(",");
    if (fields.length < 8) continue;
    const openTime = Number(fields[0]);
    const quoteVolume = Number(fields[7]);
    if (!Number.isFinite(openTime) || !Number.isFinite(quoteVolume)) continue;
    if (openTime < START || openTime >= END) continue;
    rows.push({ openTime, quoteVolume });
  }
  return rows;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

async function analyzeFunding(symbol) {
  let names;
  try {
    names = (await readdir(FUNDING_ROOT)).filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));
  } catch {
    return { fundingRows: 0, fundingCoverage: 0, fundingGaps: Number.POSITIVE_INFINITY, fundingComplete: false };
  }
  const times = new Set();
  for (const name of names) {
    try {
      const rows = JSON.parse(await readFile(`${FUNDING_ROOT}/${name}`, "utf8"));
      for (const row of Array.isArray(rows) ? rows : []) {
        const fundingTime = Number(row.fundingTime);
        if (Number.isFinite(fundingTime) && fundingTime >= START && fundingTime < END) times.add(fundingTime);
      }
    } catch {
      // The backtest data-quality gate will reject unusable rows.
    }
  }
  const ordered = [...times].sort((a, b) => a - b);
  const expected = (END - START) / (8 * HOUR_MS);
  const gaps = ordered.slice(1).map((time, index) => time - ordered[index]).filter((gap) => gap > 8 * HOUR_MS * 1.5).length;
  return {
    fundingRows: ordered.length,
    fundingCoverage: ordered.length / expected,
    fundingGaps: gaps,
    fundingComplete: ordered.length > 0 && gaps === 0
  };
}

async function analyzeSymbol(symbol) {
  const months = await readdir(`${PRICE_ROOT}/${symbol}`, { withFileTypes: true });
  const dailyQuoteVolume = new Map();
  const hours = new Set();
  for (const month of months) {
    if (!month.isDirectory()) continue;
    const files = await readdir(`${PRICE_ROOT}/${symbol}/${month.name}`);
    for (const file of files.filter((name) => name.endsWith(".csv"))) {
      const rows = parseCsvRows(await readFile(`${PRICE_ROOT}/${symbol}/${month.name}/${file}`, "utf8"));
      for (const row of rows) {
        hours.add(row.openTime);
        const day = Math.floor(row.openTime / (24 * HOUR_MS));
        dailyQuoteVolume.set(day, (dailyQuoteVolume.get(day) || 0) + row.quoteVolume);
      }
    }
  }
  const coverage = hours.size / EXPECTED_HOURS;
  const dailyValues = [...dailyQuoteVolume.values()].filter((value) => value > 0);
  const funding = await analyzeFunding(symbol);
  const orderedHours = [...hours].sort((a, b) => a - b);
  return {
    symbol,
    trainHours: hours.size,
    expectedHours: EXPECTED_HOURS,
    coverage,
    activeDays: dailyValues.length,
    medianDailyQuoteVolume: median(dailyValues),
    priceGaps: orderedHours.slice(1).map((time, index) => time - orderedHours[index]).filter((gap) => gap > HOUR_MS * 1.5).length,
    ...funding,
    complete: coverage >= MIN_COVERAGE && funding.fundingCoverage >= MIN_FUNDING_COVERAGE
  };
}

const symbols = (await readdir(PRICE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((symbol) => /^[A-Z0-9]+USDT$/.test(symbol) && !EXCLUDED_SYMBOLS.has(symbol));

const analyses = [];
let cursor = 0;
async function consume() {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++];
    try {
      const analysis = await analyzeSymbol(symbol);
      if (analysis.activeDays >= 180
        && Number.isFinite(analysis.medianDailyQuoteVolume)
        && analysis.coverage >= MIN_COVERAGE
        && analysis.fundingCoverage >= MIN_FUNDING_COVERAGE) {
        analyses.push(analysis);
      }
    } catch (error) {
      console.warn(`Skipping ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, () => consume()));

analyses.sort((a, b) => b.medianDailyQuoteVolume - a.medianDailyQuoteVolume
  || a.priceGaps - b.priceGaps
  || a.fundingGaps - b.fundingGaps
  || a.symbol.localeCompare(b.symbol));
const selected = analyses.slice(0, TARGET_SIZE);
const result = {
  generatedAt: new Date().toISOString(),
  selectionMethod: "train_only_median_daily_quote_volume_with_price_funding_coverage_and_gap_filter",
  train: { start: "2023-01-01T00:00:00.000Z", end: "2025-01-01T00:00:00.000Z" },
  minimumTrainCoverage: MIN_COVERAGE,
  minimumFundingCoverage: MIN_FUNDING_COVERAGE,
  targetSize: TARGET_SIZE,
  excludedSymbols: [...EXCLUDED_SYMBOLS],
  selectedSize: selected.length,
  selectedSymbols: selected.map((item) => item.symbol),
  selected,
  eligibleCount: analyses.length,
  qualityBands: {
    coverageAtLeast95: analyses.filter((item) => item.coverage >= 0.95).length,
    coverageAtLeast75: analyses.filter((item) => item.coverage >= 0.75).length,
    coverageAtLeast50: analyses.filter((item) => item.coverage >= 0.5).length,
    fundingCoverageAtLeast95: analyses.filter((item) => item.fundingCoverage >= 0.95).length
  },
  eligibleUniverse: analyses
};
await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  selectedSize: result.selectedSize,
  eligibleCount: result.eligibleCount,
  selectedSymbols: result.selectedSymbols,
  lowestSelectedVolume: selected.at(-1)?.medianDailyQuoteVolume || null
}, null, 2));
if (selected.length < TARGET_SIZE) process.exitCode = 1;
