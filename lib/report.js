import { CONFIG } from "./config.js";
import {
  V42_FORWARD_MODEL,
  buildSignalEmailPerformanceContext,
  performanceEmailLines
} from "./performance-summary.js";
import { getTradeSpecForSignal } from "./trading/trade-spec.js";

export function renderSignalEmail(signals, { performanceSnapshot = null, historySignals = [] } = {}) {
  const sorted = [...signals].sort((a, b) => displayScore(b) - displayScore(a));
  const top = sorted[0];
  const topScore = Math.max(...sorted.map(displayScore));
  const snapshot = performanceSnapshot || buildSignalEmailPerformanceContext({
    signals,
    historySignals
  });
  const subjectPrefix = snapshot?.modelId === V42_FORWARD_MODEL.modelId
    ? "[V4.2 | SIGNAL-ONLY]"
    : "[SIGNAL-ONLY]";
  const subject = signals.length > 1
    ? `${subjectPrefix} ${signals.length}个机会，Top ${top.asset} ${plainDirection(top)} ${topScore}/100`
    : `${subjectPrefix} ${top.asset} ${plainDirection(top)} ${topScore}/100`;

  const cards = sorted.map(renderSignalCard).join("\n\n---\n\n");
  const performanceContext = performanceEmailLines(snapshot).join("\n");
  const performanceNote = snapshot?.modelId === V42_FORWARD_MODEL.modelId
    ? "\n口径说明：按已完成 Forward 信号复盘逐笔复合，仅用于模型跟踪，不代表真实账户资金曲线。"
    : "";

  return {
    subject,
    text: `${performanceContext}${performanceNote}\n\n${cards}\n\n本系统仅提供市场信号和数据分析，不自动开仓、不自动下单、不自动设置仓位或平仓。是否交易、仓位、止盈止损和平仓均由用户自行人工决定。`
  };
}

export function renderTestEmail() {
  return `云端信号系统测试邮件

如果你收到这封邮件，说明邮件服务可以正常发送。
正式提醒会使用下面这种极简格式：

BTCUSDT
方向：做多观察
信号级别：TRADE_WATCH / 高质量人工关注
推荐指数：82/100（仅用于排序）
生成时间：2026/06/21 18:00
参考价：4168.7
当前价：N/A
价格漂移：N/A
止损：4043.64（REFERENCE ONLY）
止盈：4393.81（REFERENCE ONLY）
有效期：2026/06/21 18:00 前
原因：放量突破，强于BTC
失效条件：价格重新回到关键位内侧
历史样本状态：仅供参考，未构成盈利保证

本系统仅提供市场信号和数据分析，是否交易、仓位、止盈止损和平仓均由用户自行人工决定。
收件人：${CONFIG.recipient}`;
}

function renderSignalCard(signal) {
  if (signal.kind === "futures_arbitrage") return renderArbitrageCard(signal);

  const tradeSpec = getTradeSpecForSignal(signal);
  const referencePrice = tradeSpec?.entry?.referencePrice ?? tradeSpec?.referencePrice ?? signal.close;
  const currentPrice = Number(signal.currentPrice);
  const reference = Number(referencePrice);
  const drift = Number.isFinite(Number(signal.priceDriftPct))
    ? Number(signal.priceDriftPct)
    : Number.isFinite(currentPrice) && Number.isFinite(reference) && reference > 0
      ? currentPrice / reference - 1
      : null;
  return `${signal.asset}
方向：${plainDirection(signal)}
信号级别：${signal.signalTierLabel || signal.alertTierLabel || "TRADE_WATCH / 高质量人工关注"}
推荐指数：${displayScore(signal)}/100（仅用于排序）
生成时间：${formatDate(signal.signalAvailableAt || signal.triggerTime)}
参考价：${num(referencePrice)}
当前价：${num(currentPrice)}
价格漂移：${pct(drift)}
止损：${num(tradeSpec?.stopLoss)}（REFERENCE ONLY）
止盈：${num(tradeSpec?.takeProfit)}（REFERENCE ONLY）
有效期：${formatDate(signal.validUntil)} 前
原因：${shortReason(signal)}
失效条件：${cleanSentence(signal.invalidCondition) || "请根据实时行情人工判断"}
历史样本状态：${signal.historicalSampleStatus || "仅供参考，未构成盈利保证"}`;
}

function renderArbitrageCard(signal) {
  const details = signal.details || {};
  return `${signal.asset}
类型：合约套利观察
信号级别：${signal.signalTierLabel || "OBSERVATION / 观察级"}
生成时间：${formatDate(signal.signalAvailableAt || signal.triggerTime)}
参考价：${num(signal.close)}
当前价：${num(signal.currentPrice ?? details.markPrice)}
价格漂移：${pct(signal.priceDriftPct)}
推荐指数：${displayScore(signal)}/100
资金费率：${pct(details.fundingRate)} / 8小时
年化收益：${pct(details.annualizedFunding)}
下次结算：${formatDate(details.nextFundingTime)}
原因：资金费率达到提醒阈值，适合人工复核套利窗口。
失效条件：资金费率、价差或流动性不再满足条件。
历史样本状态：仅供参考，未构成盈利保证`;
}

function displayScore(signal) {
  const raw = Number(signal?.rawScore);
  if (Number.isFinite(raw)) return Math.round(raw);
  const recommendation = Number(signal?.recommendationScore);
  return Number.isFinite(recommendation) ? Math.round(recommendation) : 0;
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
  if (value == null || typeof value === "object") return "";
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
