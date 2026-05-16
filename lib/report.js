import { CONFIG } from "./config.js";

export function renderSignalEmail(signals) {
  const topScore = Math.max(...signals.map((signal) => signal.recommendationScore));
  const subject =
    signals.length > 1
      ? `跨市场多信号提醒｜最高推荐指数 ${topScore}/100`
      : `${topScore >= 80 ? "跨市场高质量交易信号提醒" : "跨市场交易信号提醒"}｜推荐指数 ${topScore}/100`;

  const overview = signals
    .map((signal, index) =>
      `${index + 1}. ${signal.asset}｜${signal.market}｜${signal.direction}｜${signal.interval}｜${signal.strategyName}｜推荐指数 ${signal.recommendationScore}/100｜胜率 ${pct(signal.metrics.winRate)}｜历史总收益 ${pct(signal.metrics.totalReturn)}｜最大回撤 ${pct(signal.metrics.maxDrawdown)}｜有效期 ${formatDate(signal.validUntil)}`
    )
    .join("\n");

  const cards = signals.map(renderSignalCard).join("\n\n");
  return {
    subject,
    text: `【信号总览】\n${overview}\n\n${cards}\n\n说明：这只是信号提醒，不是投资建议；系统不会自动交易。合约存在资金费率、滑点、插针和强平风险，历史表现不代表未来收益，请自行判断并控制仓位。`
  };
}

export function renderTestEmail() {
  return `这是一封云端信号系统测试邮件。\n\n如果你收到这封邮件，说明邮件服务配置已经可以从云端触发。\n\n当前系统设计：\n- 每 4 小时由 GitHub Actions 触发 Vercel API。\n- 扫描虚拟货币现货、USDT 永续合约、美股/ETF、原油/黄金代理等资产。\n- 用历史表现 + 当前环境过滤生成推荐指数。\n- 只在新信号出现时提醒，不自动交易。\n\n收件人：${CONFIG.recipient}`;
}

function renderSignalCard(signal) {
  const checks = signal.filters.checks.map(([name, status, note]) => `- ${name}：${status}，${note}`).join("\n");
  return `【信号决策卡】\n推荐指数：${signal.recommendationScore}/100\n等级：${grade(signal.recommendationScore)}\n一句话结论：${summary(signal)}\n\n信号摘要：\n- 资产/代码：${signal.asset}\n- 市场类别：${signal.market}\n- 周期：${signal.interval}\n- 策略名称：${signal.strategyName}\n- 方向：${signal.direction}\n- 触发时间：${formatDate(signal.triggerTime)}\n\n关键数据：\n- 触发收盘价：${num(signal.close)}\n- 胜率：${pct(signal.metrics.winRate)}\n- 历史总收益：${pct(signal.metrics.totalReturn)}\n- 年化收益：${pct(signal.metrics.cagr)}\n- 盈利因子：${num(signal.metrics.profitFactor)}\n- 最大回撤：${pct(signal.metrics.maxDrawdown)}\n- 交易次数：${signal.metrics.trades}\n- 样本区间：${formatDate(signal.metrics.sampleStart)} 至 ${formatDate(signal.metrics.sampleEnd)}\n- 策略指标：${formatDetails(signal.details)}\n\n触发条件：\n${signal.triggerReason}\n\n策略执行参考流程：\n- 等待触发 K 线收盘确认，不追未收盘信号。\n- 如果决定交易，可关注触发收盘价附近，或回踩关键位不破后的机会。\n- 可考虑分批，而不是一次性满仓。\n- 风控参考：跌回触发位/关键均线下方，或策略条件失效时放弃。\n- 止盈/退出参考：参考历史持有周期，或趋势条件失效时退出。\n- 仓位提示：现货/ETF 优先；如果是合约信号，只适合作为低杠杆观察，必须预先设硬止损并考虑强平风险。\n\n有效期：\n${signal.interval === "4h" ? "触发后 1-2 根 4h K 线内更有参考价值；超过约 8 小时且价格已明显远离触发位，视为过期。" : "触发后 1-3 个交易日/K 线内更有参考价值；跌回触发位下方视为失效。"}\n\n失效条件：\n${signal.invalidCondition}\n\n多维过滤结果：\n${checks}`;
}

function grade(score) {
  if (score >= 80) return "高";
  if (score >= 65) return "中";
  return "观察";
}

function summary(signal) {
  if (signal.market.includes("合约")) {
    return signal.recommendationScore >= 80
      ? "合约信号的历史表现和当前环境较强，但必须控制杠杆和强平风险。"
      : "合约信号达到中等置信，需要结合资金费率、持仓量和止损距离人工确认。";
  }
  if (signal.recommendationScore >= 80) return "历史表现、趋势环境和可执行性较好，值得重点观察。";
  return "信号达到中等置信，需要结合价格位置和仓位进一步人工确认。";
}

function pct(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
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
    .join("，");
}
