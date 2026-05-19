import { CONFIG } from "./config.js";

export function renderSignalEmail(signals) {
  const topScore = Math.max(...signals.map((signal) => signal.recommendationScore));
  const subject =
    signals.length > 1
      ? `跨市场多信号提醒 - 最高推荐指数 ${topScore}/100`
      : `${topScore >= 80 ? "跨市场高质量信号提醒" : "跨市场交易信号提醒"} - 推荐指数 ${topScore}/100`;

  const overview = signals
    .map((signal, index) =>
      `${index + 1}. ${signal.asset} | ${signal.market} | ${signal.direction} | ${signal.interval} | ${signal.strategyName} | 推荐指数 ${signal.recommendationScore}/100 | ${summaryMetric(signal)} | 有效期 ${formatDate(signal.validUntil)}`
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

  const checks = signal.filters.checks.map(([name, status, note]) => `- ${name}：${status}：${note}`).join("\n");
  return `【信号决策卡】
推荐指数：${signal.recommendationScore}/100
等级：${grade(signal.recommendationScore)}
一句话结论：${summary(signal)}

信号摘要：
- 资产/代码：${signal.asset}
- 市场类别：${signal.market}
- 方向：${signal.direction}
- 周期：${signal.interval}
- 策略名称：${signal.strategyName}
- 触发时间：${formatDate(signal.triggerTime)}

关键数据：
- 当前价格：${num(signal.close)}
- 胜率：${pct(signal.metrics.winRate)}
- 历史收益：${pct(signal.metrics.totalReturn)}
- 年化收益：${pct(signal.metrics.cagr)}
- 盈利因子：${num(signal.metrics.profitFactor)}
- 最大回撤：${pct(signal.metrics.maxDrawdown)}
- 交易次数：${signal.metrics.trades}
- 样本区间：${formatDate(signal.metrics.sampleStart)} 至 ${formatDate(signal.metrics.sampleEnd)}
- 策略指标：${formatDetails(signal.details)}

触发条件：
${signal.triggerReason}

参考执行流程：
- 等待触发 K 线收盘确认，不追未收盘信号。
- 如决定交易，可关注触发收盘价附近，或回踩关键位不破后的机会。
- 可考虑分批，而不是一次性满仓。
- 风控参考：跌回触发位/关键均线下方，或策略条件失效时放弃。
- 止盈/退出参考：参考历史持有周期，或趋势条件失效时退出。
- 仓位提示：现货/ETF 优先；如果是合约信号，只适合作为低杠杆观察，必须预先设置硬止损并考虑强平风险。

有效期：
${signal.interval === "4h" ? "触发后 1-2 根 4h K 线内更有参考价值；超过约 8 小时且价格已明显远离触发位，视为过期。" : "触发后 1-3 个交易日/K 线内更有参考价值；跌回触发位下方视为失效。"}

失效条件：
${signal.invalidCondition}

多维过滤结果：
${checks}`;
}

function renderArbitrageCard(signal) {
  const details = signal.details || {};
  const checks = signal.filters.checks.map(([name, status, note]) => `- ${name}：${status}：${note}`).join("\n");
  const isPositive = details.fundingRate > 0;
  const execution = isPositive
    ? [
        "买入等值现货，同时卖出等值 USDT 永续合约，目标是尽量中性对冲价格波动。",
        "只在接近资金费结算前、盘口深度足够、滑点可控时考虑进场。",
        "收到资金费后复查费率，如果费率低于阈值或基差反向扩大，优先退出两边仓位。",
        "合约侧不使用高杠杆，预留保证金，避免单边插针触发强平。"
      ]
    : [
        "负资金费率代表多头收钱，理论组合是买入永续并用现货侧或稳定币敞口做对冲。",
        "如果无法稳定做空现货，负费率套利不算完整中性套利，只能当作低杠杆观察。",
        "收到资金费后复查费率，如果费率回到中性或价格风险扩大，优先退出。",
        "合约侧不使用高杠杆，预留保证金，避免强平风险。"
      ];

  return `【合约套利观察卡】
推荐指数：${signal.recommendationScore}/100
等级：${grade(signal.recommendationScore)}
资产：${signal.asset}
策略：${signal.strategyName}
方向：${signal.direction}
当前价格：${num(signal.close)}

收益测算：
- 资金费率：${pct(details.fundingRate)} / 8h
- 预估日化：${pct(details.estimatedDailyFunding)}
- 预估年化：${pct(details.annualizedFunding)}
- 估算总摩擦成本：${pct(CONFIG.arbitrageTradingCost)}
- 估算手续费回本：${num(details.breakEvenDays)} 天
- Mark/Index 基差：${details.basis == null ? "N/A" : pct(details.basis)}
- 下次资金费结算：${formatDate(details.nextFundingTime)}

参与阈值：
- 邮件提醒主条件：资金费理论年化 >= ${pct(CONFIG.arbitrageAnnualizedThreshold)}。
- 折算到 8h 资金费率约为 >= ${pct(CONFIG.arbitrageAnnualizedThreshold / 365 / 3)} / 8h。
- 辅助参考：估算回本 <= ${CONFIG.arbitrageMaxBreakEvenDays} 天、基差不过度偏离、盘口深度足够。
- 低于阈值通常不值得频繁操作，因为手续费、滑点和两腿成交差会吃掉收益。

参考执行流程：
${execution.map((line) => `- ${line}`).join("\n")}

有效期：
资金费率套利信号主要在下一次资金费结算前有效；结算后必须重新评估，不沿用旧信号。

失效条件：
${signal.invalidCondition}

多维过滤结果：
${checks}`;
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

function summaryMetric(signal) {
  if (signal.kind === "futures_arbitrage") {
    return `资金费率 ${pct(signal.details?.fundingRate)} / 8h | 年化 ${pct(signal.details?.annualizedFunding)} | 回本 ${num(signal.details?.breakEvenDays)} 天`;
  }
  return `胜率 ${pct(signal.metrics.winRate)} | 历史总收益 ${pct(signal.metrics.totalReturn)} | 最大回撤 ${pct(signal.metrics.maxDrawdown)}`;
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
