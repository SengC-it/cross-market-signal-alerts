import { tryReviewFundingCarryV2PaperRun } from "../lib/funding-carry-v2-paper.js";
import { execFileSync } from "node:child_process";

const encoded = process.argv[2];
if (!encoded) throw new Error("Expected one base64-encoded cr_paper_model_runs row");

const run = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const curlMode = process.argv.includes("--curl");
const review = await tryReviewFundingCarryV2PaperRun({
  run,
  now: Date.now(),
  ...(curlMode ? {
    getCandles: getCandlesWithCurl,
    getFunding: getFundingWithCurl
  } : {}),
  persistReview: async ({ review: nextReview }) => ({ ...run, review: nextReview })
});

console.log(JSON.stringify({
  modelId: run.model_id,
  rebalanceTime: run.rebalance_time,
  review
}));

function getCandlesWithCurl(symbol, interval, startTime, endTime, limit) {
  const params = new URLSearchParams({ symbol, interval, startTime, endTime, limit });
  return curlJson(`https://fapi.binance.com/fapi/v1/klines?${params}`).map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    quoteVolume: Number(row[7])
  }));
}

function getFundingWithCurl(symbol, startTime, endTime) {
  const params = new URLSearchParams({ symbol, startTime, endTime, limit: "1000" });
  return curlJson(`https://fapi.binance.com/fapi/v1/fundingRate?${params}`).map((row) => ({
    symbol,
    fundingRate: Number(row.fundingRate),
    fundingTime: Number(row.fundingTime)
  }));
}

function curlJson(url) {
  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  const output = execFileSync(executable, ["-sS", "--fail", "--retry", "3", "--retry-all-errors", "--max-time", "30", url], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  return JSON.parse(output);
}
