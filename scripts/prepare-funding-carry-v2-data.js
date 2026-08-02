import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// This is a deterministic acquisition pool only.  The final universe is selected
// by select-funding-carry-v2-universe.js using Train-period observations.  The
// expanded tail is intentional: the initial 50-symbol pool produced only 76
// complete Train candidates, so V2 must have enough older contracts available
// to attempt the requested 100-symbol fallback without using Validation/Test
// information for ranking.
const BASE_SYMBOLS = [
  "ETHUSDT", "BTCUSDT", "SOLUSDT", "ZECUSDT", "BNBUSDT", "DOGEUSDT", "XRPUSDT", "ADAUSDT",
  "COTIUSDT", "1000SHIBUSDT", "AAVEUSDT", "UNIUSDT", "LINKUSDT", "AVAXUSDT", "NEARUSDT",
  "LTCUSDT", "DOTUSDT", "FILUSDT", "TRXUSDT", "BCHUSDT", "XMRUSDT", "INJUSDT", "XLMUSDT",
  "ETCUSDT", "1000XECUSDT", "APTUSDT", "DASHUSDT", "OPUSDT", "HBARUSDT", "LDOUSDT",
  "ICPUSDT", "CRVUSDT", "ATOMUSDT", "ROSEUSDT", "ZENUSDT", "GALAUSDT", "OGNUSDT",
  "CHZUSDT", "PEOPLEUSDT", "KSMUSDT", "SANDUSDT", "ALGOUSDT", "BANDUSDT", "ZILUSDT",
  "RLCUSDT", "ICXUSDT", "FLOWUSDT", "SNXUSDT", "JASMYUSDT", "STORJUSDT", "DYDXUSDT",
  "VETUSDT", "SKLUSDT", "LPTUSDT", "EGLDUSDT", "QNTUSDT", "YFIUSDT", "1000LUNCUSDT",
  "GRTUSDT", "RUNEUSDT", "AXSUSDT", "APEUSDT", "TRBUSDT", "BELUSDT", "BTCDOMUSDT",
  "IOTAUSDT", "MANAUSDT", "ARUSDT", "GMTUSDT", "KAVAUSDT", "SUSHIUSDT", "ENSUSDT",
  "ALICEUSDT", "IMXUSDT", "RSRUSDT", "LUNA2USDT", "ARPAUSDT", "STGUSDT", "NEOUSDT", "1INCHUSDT"
];
const EXPANDED_OLDER_SYMBOLS = [
  "MATICUSDT", "MKRUSDT", "COMPUSDT", "THETAUSDT", "KNCUSDT", "BATUSDT", "ZRXUSDT", "OMGUSDT",
  "LRCUSDT", "KLAYUSDT", "FETUSDT", "WOOUSDT", "MAGICUSDT", "CELOUSDT", "ENJUSDT", "STMXUSDT",
  "REEFUSDT", "OCEANUSDT", "DENTUSDT", "TOMOUSDT", "UNFIUSDT", "WAVESUSDT", "SXPUSDT", "NKNUSDT",
  "FLMUSDT", "CVXUSDT", "API3USDT", "GTCUSDT", "C98USDT", "CTKUSDT", "CVCUSDT", "ONEUSDT",
  "HOTUSDT", "IOTXUSDT", "DUSKUSDT", "ANKRUSDT", "CELRUSDT", "CTSIUSDT", "LINAUSDT", "MTLUSDT",
  "QTUMUSDT", "RENUSDT", "TLMUSDT", "FTMUSDT"
];
const SYMBOLS = (process.env.FUNDING_CARRY_V2_SYMBOLS || [...BASE_SYMBOLS, ...EXPANDED_OLDER_SYMBOLS].join(","))
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter((symbol, index, all) => symbol && all.indexOf(symbol) === index);

const START = Date.parse(process.env.FUNDING_CARRY_V2_PREP_START || "2023-01-01T00:00:00Z");
const END = Date.parse(process.env.FUNDING_CARRY_V2_PREP_END || "2026-07-01T00:00:00Z");
const VISION_ROOT = process.env.FUNDING_CARRY_V2_VISION_ROOT || ".backtest-cache/binance-vision-futures-1h";
const FUNDING_ROOT = process.env.FUNDING_CARRY_V2_FUNDING_CACHE || ".backtest-cache/v3-2-funding";
const CONCURRENCY = Math.max(1, Number(process.env.FUNDING_CARRY_V2_DOWNLOAD_CONCURRENCY || 3));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.FUNDING_CARRY_V2_DOWNLOAD_DELAY_MS || 100));
const REQUEST_TIMEOUT_SEC = Math.max(5, Number(process.env.FUNDING_CARRY_V2_DOWNLOAD_TIMEOUT_SEC || 30));
const MANIFEST_FILE = process.env.FUNDING_CARRY_V2_CANDIDATE_MANIFEST || "funding_carry_v2_candidate_manifest_2026-08-02.json";

function monthKeys(start, end) {
  const keys = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  const last = new Date(Date.UTC(new Date(end - 1).getUTCFullYear(), new Date(end - 1).getUTCMonth(), 1));
  while (cursor <= last) {
    keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function powershell(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function ensureVisionMonth(symbol, month) {
  const directory = `${VISION_ROOT}/${symbol}/${month}`;
  const csvPath = `${directory}/${symbol}-1h-${month}.csv`;
  if (existsSync(csvPath)) return "cached";
  const zipPath = `${directory}/${symbol}-1h-${month}.zip`;
  await mkdir(directory, { recursive: true });
  const escapedUrl = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${month}.zip`.replaceAll("'", "''");
  const escapedZip = zipPath.replaceAll("'", "''");
  const escapedDirectory = directory.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference='Stop';",
    "$ProgressPreference='SilentlyContinue';",
    "try {",
    `Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedZip}' -UseBasicParsing -TimeoutSec ${REQUEST_TIMEOUT_SEC};`,
    `Expand-Archive -Path '${escapedZip}' -DestinationPath '${escapedDirectory}' -Force;`,
    "'OK'",
    "} catch {",
    "if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { 'MISSING'; exit 0 }",
    "Write-Error $_; exit 1",
    "}"
  ].join(" ");
  try {
    const result = powershell(command).trim();
    if (result.includes("MISSING") || !existsSync(csvPath)) return "missing";
    return "downloaded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${symbol} ${month}: ${message}`);
  }
}

async function downloadSymbol(symbol, months) {
  let downloaded = 0;
  let cached = 0;
  let missing = 0;
  for (const month of months) {
    const status = await ensureVisionMonth(symbol, month);
    if (status === "downloaded") downloaded++;
    else if (status === "cached") cached++;
    else missing++;
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
  }
  return { symbol, downloaded, cached, missing };
}

async function downloadFunding() {
  const symbols = SYMBOLS.join(",");
  const script = "scripts/download-v3-2-funding.ps1";
  execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-StartTime", String(START), "-EndTime", String(END), "-Symbols", symbols
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "inherit" });
}

const months = monthKeys(START, END);
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < SYMBOLS.length) {
    const symbol = SYMBOLS[cursor++];
    try {
      const result = await downloadSymbol(symbol, months);
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { symbol, error: error instanceof Error ? error.message : String(error) };
      results.push(result);
      console.error(JSON.stringify(result));
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, SYMBOLS.length) }, () => worker()));
await mkdir(FUNDING_ROOT, { recursive: true });
if (process.env.FUNDING_CARRY_V2_SKIP_FUNDING === "1") {
  console.log("Skipping funding download for this price-only preparation pass.");
} else {
  console.log(`Downloading missing funding history for ${SYMBOLS.length} symbols...`);
  await downloadFunding();
}

const manifest = {
  generatedAt: new Date().toISOString(),
  purpose: "Acquisition manifest only; final universe ranking uses Train-period price and funding coverage/volume.",
  symbols: SYMBOLS,
  train: { start: new Date(START).toISOString(), end: new Date(Date.parse("2025-01-01T00:00:00Z")).toISOString() },
  validation: { start: "2025-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
  test: { start: "2026-01-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
  results
};
await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ symbols: SYMBOLS.length, months: months.length, manifest: MANIFEST_FILE }, null, 2));
