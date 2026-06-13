import { CONFIG } from "./config.js";

export function renderSignalEmail(signals) {
  const topScore = Math.max(...signals.map((signal) => signal.recommendationScore));
  const subject =
    signals.length > 1
      ? `跨市场多信号提醒 - 最高推荐指数 ${topScore}/100`
      : `${topScore >= 80 ? "跨市场高质量信号提醒" : "跨市场交易信号提醒"} - 推荐指数 ${topScore}/100`;

  const overview = signals
    .map((signal, index) =>
      `${index + 1}. ${signal.asset} | ${plainMarket(signal)} | ${plainDirection(signal)} | 推荐指数 ${signal.recommendationScore}/100 | ${summaryMetric(signal)} | 建议在 ${formatDate(signal.validUntil)} 前复核`
    )
    .join("\n");

  const cards = signals.map(renderSignalCard).join("\n\n");
  return {
    subject,
    text: `【信号总览】\n${overview}\n\n${cards}\n\n说明：这只是信号提醒，不是投资建议；系统不会自动交易，不访问交易账户，也不会下单。合约存在资金费率、滑点、插针、保证金、杠杆和强平风险。历史表现不代表未来收益，请自行判断并控制仓位。`
  };
}

export function renderTestEmail() {
  return `这是一封云端信号系统测试邮件。\n\n如果你收到这封邮件，说明邮件服务配置已经可以从云端触发。\n\n当前系统设计：\n- 每 1 小时由 GitHub Actions / Supabase 调度触发 Vercel API。\n- 扫描虚拟货币现货、USDT 永续合约、合约套利、美股/ETF、原油/黄金/白银代理等资产。\n- 用历史表现 + 当前环境过滤生成推荐指数。\n- 只在新信号出现时提醒，不自动交易。\n\n收件人：${CONFIG.recipient}`;
}

function renderSignalCard(signal) {
  if (signal.kind === "futures_arbitrage") return renderArbitrageCard(signal);

  return `【机会提醒】
推荐指数：${signal.recommendationScore}/100
适合级别：${grade(signal.recommendationScore)}
一句话结论：${plainSummary(signal)}

这是什么机会：
- 品种：${signal.asset}
- 市场：${plainMarket(signal)}
- 方向：${plainDirection(signal)}
- 当前参考价格：${num(signal.close)}
- 提醒时间：${formatDate(signal.triggerTime)}
- 建议复核截止：${formatDate(signal.validUntil)}

为什么提醒你：
- 历史胜率：${pct(signal.metrics.winRate)}
- 历史总收益：${pct(signal.metrics.totalReturn)}
- 最近表现：${recentSummary(signal.metrics.recent)}
- 已发提醒复盘：${livePerformanceSummary(signal.livePerformance)}
- 本次过滤说明：${gateNotesSummary(signal.gateNotes)}
- 推荐指数拆解：${scoringBreakdownSummary(signal.scoringBreakdown)}
- 最大回撤：${pct(signal.metrics.maxDrawdown)}
- 历史样本：${signal.metrics.trades} 次，${formatDate(signal.metrics.sampleStart)} 至 ${formatDate(signal.metrics.sampleEnd)}

你可以怎么处理：
- 这不是下单指令，只是提醒你“值得看一眼”。
- 如果你看不懂这个品种或风险，就先不做。
- 如果决定参与，建议小仓位、分批，不要一次性满仓。
- 如果是合约，只建议低杠杆或仅观察；不要高杠杆。
- 如果价格已经明显涨/跌过一大段，宁可错过，不要追。

什么时候失效：
${plainInvalidCondition(signal)}

备注：
系统使用历史价格、近期走势、成交活跃度和风险指标综合打分；历史表现不代表未来一定盈利。`;
}

function renderArbitrageCard(signal) {
  const details = signal.details || {};
  const isPositive = details.fundingRate > 0;
  const plainPlan = isPositive
    ? "简单理解：有人愿意付费持有多头，理论上可用“买现货 + 做空合约”的方式观察套利。"
    : "简单理解：有人愿意付费持有空头，理论上可用“做多合约 + 另一边对冲”的方式观察套利。";

  return `【合约套利提醒】
推荐指数：${signal.recommendationScore}/100
适合级别：${grade(signal.recommendationScore)}
品种：${signal.asset}
当前参考价格：${num(signal.close)}

一句话结论：
${plainPlan}

关键数字：
- 资金费率：${pct(details.fundingRate)} / 8小时
- 估算年化：${pct(details.annualizedFunding)}
- 估算每天收益：${pct(details.estimatedDailyFunding)}
- 保守扣成本后日收益：${pct(details.estimatedNetDailyAfterCost)}
- 估算成本回本：${num(details.breakEvenDays)} 天
- 下次结算时间：${formatDate(details.nextFundingTime)}

你可以怎么处理：
- 这类机会比普通买涨买跌复杂，不懂就先只观察。
- 必须同时考虑两边交易、手续费、滑点和保证金。
- 不建议高杠杆；合约波动可能导致强平。
- 结算后要重新评估，不能沿用旧提醒。

什么时候失效：
下次资金费结算后、费率明显下降、买卖价差扩大，或任一边不好成交时，这个机会就应视为失效。

提醒阈值：
系统只在估算年化达到 ${pct(CONFIG.arbitrageAnnualizedThreshold)} 以上时提醒。`;
}

function grade(score) {
  if (score >= 80) return "高";
  if (score >= 65) return "中";
  return "观察";
}

function summary(signal) {
  if (signal.kind === "futures_arbitrage") {
    return signal.recommendationScore >= 80
      ? "资金费率套利窗口较强，但仍需确认两边盘口、手续费、滑点和保证金安全边际。"
      : "资金费率达到观察阈值，适合人工复核，不适合无脑开仓。";
  }
  if (signal.market.includes("合约")) {
    return signal.recommendationScore >= 80
      ? "合约信号的历史表现和当前环境较强，但必须控制杠杆、保证金占用和强平风险。"
      : "合约信号达到中等置信，需要结合资金费率、持仓量和止损距离人工确认。";
  }
  if (signal.recommendationScore >= 80) return "历史表现、趋势环境和可执行性较好，值得重点观察。";
  return "信号达到中等置信，需要结合价格位置和仓位进一步人工确认。";
}

function plainSummary(signal) {
  if (signal.market.includes("合约")) {
    return signal.recommendationScore >= 80
      ? "这是一个较强的合约观察机会，但风险也更高，适合谨慎复核。"
      : "这是一个中等强度的合约观察机会，建议先看风险，再决定是否参与。";
  }
  if (signal.recommendationScore >= 80) return "这是一个较强的观察机会，值得你打开行情看一下。";
  return "这是一个中等强度的观察机会，不需要急着行动。";
}

function summaryMetric(signal) {
  if (signal.kind === "futures_arbitrage") {
    return `资金费率 ${pct(signal.details?.fundingRate)} / 8h | 年化 ${pct(signal.details?.annualizedFunding)} | 回本 ${num(signal.details?.breakEvenDays)} 天`;
  }
  return `胜率 ${pct(signal.metrics.winRate)} | 近期 ${recentPct(signal.metrics.recent?.winRate)} / ${pct(signal.metrics.recent?.totalReturn)} | 最大回撤 ${pct(signal.metrics.maxDrawdown)}`;
}

function plainMarket(signal) {
  if (signal.market.includes("合约")) return "合约";
  if (signal.market.includes("现货")) return "虚拟货币现货";
  if (signal.market.includes("商品")) return "商品/能源";
  return signal.market;
}

function plainDirection(signal) {
  if (signal.direction.includes("空")) return "偏下跌/防守";
  if (signal.direction.includes("多")) return "偏上涨";
  return signal.direction;
}

function recentSummary(recent) {
  if (!recent || !recent.trades) return "近期样本不足";
  return `${recentPct(recent.winRate)}，近 ${recent.trades} 次，收益 ${pct(recent.totalReturn)}`;
}

function livePerformanceSummary(performance) {
  if (!performance || !performance.trades) return "暂无足够已发提醒样本";
  return `${pct(performance.winRate)} 胜率，${performance.trades} 次，累计 ${pct(performance.totalReturn)}`;
}

function gateNotesSummary(notes) {
  if (!Array.isArray(notes) || !notes.length) return "通过基础风控过滤";
  return notes.join("；");
}

function scoringBreakdownSummary(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return "暂无拆解";
  return [
    `样本外 ${num(breakdown.outOfSample)}`,
    `环境 ${num(breakdown.environment)}`,
    `真实表现 ${num(breakdown.livePerformance)}`,
    `风险 ${num(breakdown.risk)}`,
    `成本/流动性 ${num(breakdown.costLiquidity)}`,
    `资金效率 ${num(breakdown.capitalEfficiency)}`
  ].join(" / ");
}

function plainInvalidCondition(signal) {
  if (signal.market.includes("合约")) {
    return "如果行情快速反向、波动突然放大，或你无法承受强平风险，就不要参与。";
  }
  if (signal.direction.includes("空")) {
    return "如果价格重新转强，或者你看不懂下跌风险，就不要参与。";
  }
  return "如果价格明显反向，或者已经远离提醒时的价格，就不要追。";
}

function pct(value) {
  if (!Number.isFinite(value)) return "N/A";
  const pctValue = value * 100;
  const absValue = Math.abs(pctValue);
  const digits = absValue > 10 ? 1 : absValue >= 1 ? 2 : 4;
  return `${pctValue.toFixed(digits)}%`;
}

function recentPct(value) {
  return Number.isFinite(value) ? pct(value) : "样本不足";
}

function num(value) {
  if (!Number.isFinite(value)) return "N/A";
  return Number(value).toFixed(4).replace(/\.?0+$/, "");
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

function formatDetails(details) {
  return Object.entries(details || {})
    .map(([key, value]) => `${key}=${num(value)}`)
    .join("；");
}
