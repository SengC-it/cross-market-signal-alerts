import { CONFIG } from "./config.js";

const SPOT_STOP_PCT = 0.03;
const DEFAULT_REWARD_RISK = CONFIG.futuresRewardRiskRatio || 1.8;

export function renderSignalEmail(signals) {
  const sorted = [...signals].sort((a, b) => displayScore(b) - displayScore(a));
  const top = sorted[0];
  const topScore = Math.max(...sorted.map(displayScore));
  const subject = signals.length > 1
    ? `信号提醒：${signals.length}个机会，Top ${top.asset} ${plainDirection(top)} ${topScore}/100`
    : `信号提醒：${top.asset} ${plainDirection(top)} ${topScore}/100`;

  const cards = sorted.map(renderSignalCard).join("\n\n---\n\n");

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
参考价：4168.7
止损：4043.64
止盈：4393.81
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
推荐指数：${displayScore(signal)}/100
参考价：${num(plan.entry)}
止损：${num(plan.stopLoss)}
止盈：${num(plan.takeProfit)}
有效期：${formatDate(signal.validUntil)} 前
原因：${shortReason(signal)}`;
}

function renderArbitrageCard(signal) {
  const details = signal.details || {};
  return `${signal.asset}
类型：合约套利观察
推荐指数：${displayScore(signal)}/100
参考价：${num(signal.close)}
资金费率：${pct(details.fundingRate)} / 8小时
年化收益：${pct(details.annualizedFunding)}
下次结算：${formatDate(details.nextFundingTime)}
原因：资金费率达到提醒阈值，适合人工复核套利窗口。`;
}

function displayScore(signal) {
  const raw = Number(signal?.rawScore);
  if (Number.isFinite(raw)) return Math.round(raw);
  const recommendation = Number(signal?.recommendationScore);
  return Number.isFinite(recommendation) ? Math.round(recommendation) : 0;
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
  if (Number.isFinite(details.volumeMultiple)) parts.push(`放量约 ${num(details.volumeMultiple)} 倍`);
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
  if (text.includes("做空") || text.includes("SHORT") || text.includes("short") || text.includes("空") || text.includes("下跌")) return "做空观察";
  if (text.includes("做多") || text.includes("LONG") || text.includes("long") || text.includes("多") || text.includes("上涨")) return "做多观察";
  return signal.direction || "观察";
}

function isShortDirection(signal) {
  const text = `${signal.direction || ""} ${signal.strategyId || ""}`;
  return text.includes("做空") || text.includes("SHORT") || text.includes("short") || text.includes("空") || text.includes("下跌");
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
