export const CONFIG = {
  recipient: process.env.ALERT_EMAIL_TO || "sheng.chi@qq.com",
  from: process.env.ALERT_EMAIL_FROM || "Signal Alerts <alerts@example.com>",
  cryptoAssets: [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "LTCUSDT",
    "DOTUSDT",
    "TRXUSDT",
    "BCHUSDT",
    "NEARUSDT",
    "APTUSDT",
    "ARBUSDT",
    "OPUSDT",
    "SUIUSDT",
    "INJUSDT",
    "UNIUSDT",
    "FILUSDT",
    "ATOMUSDT",
    "ETCUSDT",
    "AAVEUSDT"
  ],
  futuresAssets: [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT"
  ],
  equityAssets: ["SPY", "QQQ", "DIA", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"],
  commodityAssets: ["USO", "GLD", "SLV"],
  scanGroups: {
    "crypto-core": ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT"],
    "crypto-alt": ["DOTUSDT", "TRXUSDT", "BCHUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "INJUSDT", "UNIUSDT", "FILUSDT", "ATOMUSDT", "ETCUSDT", "AAVEUSDT"],
    "futures-core": ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    "tradfi": ["SPY", "QQQ", "DIA", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "USO", "GLD", "SLV"]
  },
  intervals: ["4h", "1d"],
  shortTermIntervals: ["1h", "2h"],
  minTrades: 40,
  minRecommendationScore: 65,
  maxSignalsPerEmail: 5,
  cryptoTradingCost: 0.002,
  futuresTradingCost: 0.0012,
  equityTradingCost: 0.001
};

export function intervalHours(interval) {
  const map = {
    "1h": 1,
    "2h": 2,
    "4h": 4,
    "1d": 24
  };
  return map[interval] || 24;
}
