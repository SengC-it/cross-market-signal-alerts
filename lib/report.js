import { CONFIG } from "./config.js";

const SPOT_STOP_PCT = 0.03;
const DEFAULT_REWARD_RISK = CONFIG.futuresRewardRiskRatio || 1.8;

export function renderSignalEmail(signals) {
  const topScore = Math.max(...signals.map((signal) => signal.recommendationScore));
  const subject = signals.length > 1
    ? `信号提醒：${signals.length}个机会 最高${topScore}/100`
    : `信号提醒：${signals[0].asset} ${plainDirection(signals[0])} ${topScore}/100`;

  const cards = signals.map(renderSignalCard).join("\n\n---\n\n");

  return {
    subject,
    text: `${cards}\n\n提醒：这只是信号提醒，不是自动交易。请自己确认仓位，并严格按止损控制风险。`
  };
}

export function renderTestEmail() {
  return `云端信号系统测试邮件

如果你收到这封邮件，说明邮件服务可以正常发送。

正式提醒会使用下面这种极简格式：

BTCUSDT
方向：做多观察
推荐指数：82/100
参考价：64168.7
止损：62243.64
止盈：67635.81
有效期：2026/06/21 18:00 前

原因：放量突破，强于BTC
提醒：不是自动交易，请按止损控制风险。

收件人：${CONFIG.recipient}`;
}

function renderSignalCard(signal) {
  if (signal.kind === "futures_arbitrage") return renderArbitrageCard(signal);

  const plan = buildTradePlan(signal);
  return `${signal.asset}
方向：${plainDirection(signal)}
推荐指数：${signal.recommendationScore}/100
参考价：${num(plan.entry)}
止损：${num(plan.stopLoss)}
止盈：${num(plan.takeProfit)}
有效期：${formatDate(signal.validUntil)} 前

原因：${shortReason(signal)}
提醒：不是自动交易，请按止损控制风险。`;
}

function renderArbitrageCard(signal) {
  const details = signal.details || {};
  return `${signal.asset}
类型：合约套利观察
推荐指数：${signal.recommendationScore}/100
参考价：${num(signal.close)}
资金费率：${pct(details.fundingRate)} / 8小时
年化收益：${pct(details.annualizedFunding)}
下次结算：${formatDate(details.nextFundingTime)}

原因：资金费率达到提醒阈值，适合人工复核套利窗口。
提醒：这类机会需要同时处理现货和合约，两边成交、手续费、滑点和保证金都要确认。`;
}

function buildTradePlan(signal) {
  const entry = Number(signal.executionPlan?.entryReference ?? signal.close);
  if (!Number.isFinite(entry)) {
    return { entry: null, stopLoss: null, takeProfit: null };
  }

  if (Number.isFinite(signal.executionPlan?.stopLoss) && Number.isFinite(signal.executionPlan?.takeProfit)) {
    return {
      entry,
      stopLoss: signal.executionPlan.stopLoss,
      takeProfit: signal.executionPlan.takeProfit
    };
  }

  const isShort = isShortDirection(signal);
  const stopDistance = entry * SPOT_STOP_PCT;
  const targetDistance = stopDistance * DEFAULT_REWARD_RISK;
  return {
    entry,
    stopLoss: isShort ? entry + stopDistance : entry - stopDistance,
    takeProfit: isShort ? entry - targetDistance : entry + targetDistance
  };
}

function shortReason(signal) {
  if (signal.executionPlan?.simpleThesis) return cleanSentence(signal.executionPlan.simpleThesis);
  if (signal.kind === "futures_arbitrage") return "资金费率达到提醒阈值，适合人工复核套利窗口。";

  const details = signal.details || {};
  const parts = [];
  if (Number.isFinite(details.volumeMultiple)) parts.push(`放量约${num(details.volumeMultiple)}倍`);
  if (Number.isFinite(details.relativeStrength) && details.relativeStrength > 0) parts.push(`强于BTC ${pct(details.relativeStrength)}`);
  if (signal.strategyName) parts.push(cleanSentence(signal.strategyName));
  return parts.slice(0, 2).join("，") || cleanSentence(signal.triggerReason) || "信号达到系统提醒条件。";
}

function cleanSentence(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[。；;]+$/g, "")
    .slice(0, 80);
}

function plainDirection(signal) {
  const text = `${signal.direction || ""} ${signal.strategyId || ""}`;
  if (text.includes("SHORT") || text.includes("空") || text.includes("下跌")) return "做空观察";
  if (text.includes("LONG") || text.includes("多") || text.includes("上涨")) return "做多观察";
  return signal.direction || "观察";
}

function isShortDirection(signal) {
  const text = `${signal.direction || ""} ${signal.strategyId || ""}`;
  return text.includes("SHORT") || text.includes("空") || text.includes("下跌");
}

function pct(value) {
  if (!Number.isFinite(value)) return "N/A";
  const pctValue = value * 100;
  const absValue = Math.abs(pctValue);
  const digits = absValue > 10 ? 1 : absValue >= 1 ? 2 : 4;
  return `${pctValue.toFixed(digits)}%`;
}

function num(value) {
  if (!Number.isFinite(value)) return "N/A";
  const absValue = Math.abs(value);
  const digits = absValue >= 100 ? 2 : absValue >= 1 ? 4 : 8;
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

function formatDate(value) {
  if (!value) return "N/A";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
