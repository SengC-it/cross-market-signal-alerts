import { extractBinanceExchangeFilters } from "../trading/exchange-filters.js";

const BINANCE_FUTURES_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";

export async function fetchBinanceExchangeFilters({
  symbol,
  marketType = "futures",
  fetchImpl = globalThis.fetch,
  baseUrl = marketType === "spot"
    ? "https://api.binance.com/api/v3/exchangeInfo"
    : BINANCE_FUTURES_EXCHANGE_INFO
} = {}) {
  if (!symbol || typeof fetchImpl !== "function") {
    return {
      exchangeFilters: null,
      source: "BINANCE_EXCHANGE_INFO",
      dataQuality: "INCOMPLETE_EXCHANGE_FILTERS",
      error: "INVALID_EXCHANGE_INFO_REQUEST"
    };
  }
  try {
    const response = await fetchImpl(`${baseUrl}?symbol=${encodeURIComponent(symbol)}`);
    if (!response?.ok) throw new Error(`Binance exchange info failed: ${response?.status ?? "NO_RESPONSE"}`);
    const body = await response.json();
    const exchangeFilters = extractBinanceExchangeFilters(body, symbol);
    if (!exchangeFilters) throw new Error(`Missing or invalid Binance filters: ${symbol}`);
    return {
      exchangeFilters,
      source: "BINANCE_EXCHANGE_INFO",
      dataQuality: "COMPLETE",
      error: null
    };
  } catch (error) {
    return {
      exchangeFilters: null,
      source: "BINANCE_EXCHANGE_INFO",
      dataQuality: "INCOMPLETE_EXCHANGE_FILTERS",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
