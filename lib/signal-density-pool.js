import { CONFIG } from "./config.js";
import {
  isDynamicStrongPoolCandidate,
  isDynamicWeakPoolCandidate,
  rankDynamicPoolTickers
} from "./strategies/dynamic-production.js";
import { SIGNAL_DENSITY_CONFIG } from "./signal-density-config.js";

export function rankDynamicPoolTickerDetails({
  tickers = [],
  direction = "strong",
  existing = new Set(),
  futuresSymbols = null,
  maxAssets = direction === "weak"
    ? CONFIG.dynamicWeakSpotPoolMaxAssets
    : SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets
} = {}) {
  const rankedSymbols = rankDynamicPoolTickers({
    tickers,
    direction,
    existing,
    futuresSymbols,
    maxAssets
  });
  return rankedSymbols.map((symbol, index) => ({
    symbol,
    dynamicPoolRank: index + 1,
    dynamicPoolRankBand: dynamicPoolRankBand(index + 1)
  }));
}

export function dynamicPoolRankBand(rank) {
  const normalized = Number(rank);
  if (!Number.isFinite(normalized) || normalized < 1) return null;
  if (normalized <= 10) return "1-10";
  if (normalized <= 25) return "11-25";
  return "26+";
}

export { isDynamicStrongPoolCandidate, isDynamicWeakPoolCandidate };
