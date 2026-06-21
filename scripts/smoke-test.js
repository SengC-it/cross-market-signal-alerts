import { renderSignalEmail, renderTestEmail } from "../lib/report.js";
import { STRATEGIES } from "../lib/strategies.js";

if (!STRATEGIES.length) {
  throw new Error("No strategies registered");
}

const email = renderTestEmail();
if (!email.includes("云端信号系统测试邮件")) {
  throw new Error("Test email renderer failed");
}
if (!email.includes("BTCUSDT") || !email.includes("止损：") || !email.includes("止盈：")) {
  throw new Error("Test email does not show compact signal sample");
}

const spotEmail = renderSignalEmail([{
  asset: "BTCUSDT",
  direction: "做多观察",
  strategyName: "放量突破",
  strategyId: "dynamic_relative_strength_breakout",
  recommendationScore: 82,
  close: 100,
  validUntil: Date.UTC(2026, 5, 21, 10, 0),
  details: {
    volumeMultiple: 2.5,
    relativeStrength: 0.08
  }
}]);

for (const required of ["BTCUSDT", "方向：做多观察", "推荐指数：82/100", "参考价：100", "止损：97", "止盈：105.4", "有效期：", "原因："]) {
  if (!spotEmail.text.includes(required)) {
    throw new Error(`Compact spot email missing: ${required}`);
  }
}

for (const removed of ["历史样本", "推荐指数拆解", "为什么提醒你", "你可以怎么处理"]) {
  if (spotEmail.text.includes(removed)) {
    throw new Error(`Compact spot email still contains verbose section: ${removed}`);
  }
}

const futuresEmail = renderSignalEmail([{
  asset: "ETHUSDT",
  direction: "做空观察",
  strategyId: "futures_scalp_short",
  recommendationScore: 76,
  close: 2000,
  validUntil: Date.UTC(2026, 5, 21, 11, 0),
  executionPlan: {
    entryReference: 2000,
    stopLoss: 2040,
    takeProfit: 1928,
    simpleThesis: "ETHUSDT 出现偏空合约观察信号。"
  }
}]);

for (const required of ["ETHUSDT", "方向：做空观察", "参考价：2000", "止损：2040", "止盈：1928"]) {
  if (!futuresEmail.text.includes(required)) {
    throw new Error(`Compact futures email missing: ${required}`);
  }
}

const arbitrageEmail = renderSignalEmail([{
  kind: "futures_arbitrage",
  asset: "SOLUSDT",
  recommendationScore: 81,
  close: 150,
  details: {
    fundingRate: 0.0004,
    annualizedFunding: 0.438,
    nextFundingTime: Date.UTC(2026, 5, 21, 12, 0)
  }
}]);

for (const required of ["SOLUSDT", "类型：合约套利观察", "资金费率：0.0400% / 8小时", "年化收益：43.8%", "下次结算："]) {
  if (!arbitrageEmail.text.includes(required)) {
    throw new Error(`Compact arbitrage email missing: ${required}`);
  }
}

if (arbitrageEmail.text.includes("止损：") || arbitrageEmail.text.includes("止盈：")) {
  throw new Error("Arbitrage email should not show stop loss or take profit");
}

console.log("Smoke test passed");
