import assert from "node:assert/strict";
import {
  buildPaperPerformanceSnapshot,
  buildSignalEmailPerformanceContext,
  buildV42ForwardSnapshot,
  calculateCompoundedReturn,
  formatCompoundedReturn,
  performanceEmailLines
} from "../lib/performance-summary.js";
import { renderSignalEmail } from "../lib/report.js";
import { renderV33PaperEmail, V34_MODEL } from "../lib/v3-3-paper.js";
import { renderFundingCarryV2PaperEmail, FUNDING_CARRY_V2_MODEL } from "../lib/funding-carry-v2-paper.js";

const V42 = {
  model_version: "DYNAMIC_SPOT_V2_2026-08-01",
  strategy_id: "dynamic_relative_strength_breakout",
  payload: {
    signalVariant: "STRONG_EXTENSION_10_15",
    delivery: { mode: "EMAIL" }
  }
};

function signal({ key, review = { status: "pending" }, ...overrides }) {
  const { payload: payloadOverrides = {}, ...signalOverrides } = overrides;
  return {
    ...V42,
    signal_key: key,
    asset: "BTCUSDT",
    sent_at: "2026-08-01T00:00:00.000Z",
    ...signalOverrides,
    payload: { ...V42.payload, ...payloadOverrides, review }
  };
}

function paperRun({ modelId, at, review, emailStatus = "sent", emailSentAt = "2026-08-02T00:00:00.000Z" }) {
  return {
    model_id: modelId,
    rebalance_time: at,
    email_status: emailStatus,
    email_sent_at: emailSentAt,
    targets: [{ symbol: "BTCUSDT", targetWeight: 0.1 }],
    review
  };
}

assert.ok(Math.abs(calculateCompoundedReturn([0.1, -0.05]) - 0.045) < 1e-12);
assert.equal(calculateCompoundedReturn([]), null);
assert.equal(formatCompoundedReturn(null), "暂无");
assert.equal(formatCompoundedReturn(0.045), "+4.50%");
assert.equal(formatCompoundedReturn(-0.061), "-6.10%");
assert.equal(formatCompoundedReturn(0), "0.00%");

const v42Snapshot = buildV42ForwardSnapshot([
  signal({ key: "v42-good", review: { status: "reviewed", returnPct: 0.1 } }),
  signal({ key: "v42-good", review: { status: "pending" } }),
  signal({ key: "v42-pending", review: { status: "pending" } }),
  signal({
    key: "legacy-dynamic",
    strategy_id: "legacy_dynamic_strength",
    review: { status: "reviewed", returnPct: 0.9 }
  }),
  signal({
    key: "v42-core",
    payload: { signalVariant: "STRONG_CORE_8_10" },
    review: { status: "reviewed", returnPct: 0.9 }
  }),
  signal({
    key: "v42-shadow",
    payload: { delivery: { mode: "SHADOW_ONLY" } },
    review: { status: "reviewed", returnPct: 0.9 }
  }),
  signal({
    key: "v42-research",
    payload: { signalTier: "RESEARCH_ONLY" },
    review: { status: "reviewed", returnPct: 0.9 }
  })
]);
assert.equal(v42Snapshot.completedPeriods, 1, "only the exact V4.2 Forward reviewed signal should count");
assert.ok(Math.abs(v42Snapshot.compoundedReturn - 0.1) < 1e-12);
assert.equal(v42Snapshot.modelLabel, "V4.2 Dynamic Strength");

const paperSnapshot = buildPaperPerformanceSnapshot({
  modelId: "paper-v34",
  modelLabel: "V3.4 Unified",
  runs: [
    paperRun({ modelId: "paper-v34", at: "2026-08-01T00:00:00.000Z", review: { status: "reviewed", returnPct: 0.1 } }),
    paperRun({ modelId: "paper-v34", at: "2026-08-01T00:00:00.000Z", review: { status: "pending" } }),
    paperRun({ modelId: "paper-v34", at: "2026-08-08T00:00:00.000Z", review: { status: "reviewed", returnPct: -0.05 } }),
    paperRun({ modelId: "paper-v33", at: "2026-08-15T00:00:00.000Z", review: { status: "reviewed", returnPct: 0.9 } }),
    paperRun({ modelId: "paper-v34", at: "2026-08-22T00:00:00.000Z", review: { status: "reviewed", returnPct: 0.2 }, emailStatus: "pending", emailSentAt: null })
  ]
});
assert.equal(paperSnapshot.completedPeriods, 2, "PAPER periods must be unique by model and rebalance time");
assert.ok(Math.abs(paperSnapshot.compoundedReturn - 0.045) < 1e-12);
assert.deepEqual(performanceEmailLines(paperSnapshot).slice(0, 4), [
  "策略模型：V3.4 Unified",
  "已完成周期：2",
  "已完成周期复合收益：+4.50%",
  "统计口径：Production PAPER 已完成周期"
]);
assert.equal(buildPaperPerformanceSnapshot({
  modelId: V34_MODEL.id,
  runs: [
    paperRun({ modelId: V34_MODEL.id, at: "2026-08-01T00:00:00.000Z", review: { status: "reviewed", returnPct: 0.01 } }),
    paperRun({ modelId: "v3_3_vol_target_catastrophe_breaker", at: "2026-08-08T00:00:00.000Z", review: { status: "reviewed", returnPct: 0.9 } })
  ]
}).completedPeriods, 1, "V3.4 must not include V3.3 PAPER periods");
assert.equal(buildPaperPerformanceSnapshot({
  modelId: FUNDING_CARRY_V2_MODEL.id,
  runs: [
    paperRun({ modelId: FUNDING_CARRY_V2_MODEL.id, at: "2026-08-01T00:00:00.000Z", review: { status: "reviewed", returnPct: -0.01 } }),
    paperRun({ modelId: "funding_carry_perp_reversion_ema100", at: "2026-08-08T00:00:00.000Z", review: { status: "reviewed", returnPct: 0.9 } })
  ]
}).completedPeriods, 1, "Funding Carry V2 must not include V1 periods");
const emptyLines = performanceEmailLines({ modelLabel: "V4.2 Dynamic Strength", completedPeriods: 0, compoundedReturn: null });
assert.ok(emptyLines.includes("已完成周期：0"));
assert.ok(emptyLines.includes("已完成周期复合收益：暂无"));
assert.ok(!emptyLines.some((line) => /0\.00%/.test(line)));
const emptyPaperLines = performanceEmailLines({
  modelLabel: "Funding Carry V2",
  completedPeriods: 0,
  compoundedReturn: null,
  basis: "Production PAPER 已完成周期"
});
assert.ok(emptyPaperLines.includes("统计口径：Production PAPER 已完成周期（暂无已完成样本）"));
assert.ok(!emptyPaperLines.some((line) => /Forward/.test(line)));

const dynamicEmail = renderSignalEmail([
  {
    ...V42,
    signalKey: "v42-email",
    asset: "BTCUSDT",
    close: 100,
    currentPrice: 101,
    priceDriftPct: 0.01,
    rawScore: 90,
    direction: "做多观察",
    signalTierLabel: "TRADE_WATCH",
    signalAvailableAt: "2026-08-28T09:15:00.000Z",
    modelVersion: V42.model_version,
    strategyId: V42.strategy_id,
    signalVariant: V42.payload.signalVariant,
    delivery: { mode: "EMAIL" }
  }
], {
  historySignals: [signal({ key: "v42-history", review: { status: "reviewed", returnPct: 0.0198 } })]
});
assert.match(dynamicEmail.subject, /^\[V4\.2 \| SIGNAL-ONLY\]/);
for (const required of ["策略模型：V4.2 Dynamic Strength", "策略版本：STRONG_EXTENSION_10_15", "已完成周期：1", "已完成周期复合收益：+1.98%", "统计口径：Production Forward 已完成复盘"]) {
  assert.ok(dynamicEmail.text.includes(required), `dynamic email missing ${required}`);
}
assert.match(dynamicEmail.text, /按已完成 Forward 信号复盘逐笔复合/);

const v34Email = renderV33PaperEmail({
  model_id: V34_MODEL.id,
  model_version: V34_MODEL.version,
  rebalance_time: "2026-08-28T00:00:00.000Z",
  targets: [],
  risk_state: {}
}, { performanceSnapshot: { modelLabel: "V3.4 Unified", completedPeriods: 3, compoundedReturn: -0.0418, basis: "Production PAPER 已完成周期" } });
for (const required of ["策略模型：V3.4 Unified", "已完成周期：3", "已完成周期复合收益：-4.18%", "统计口径：Production PAPER 已完成周期"]) {
  assert.ok(v34Email.text.includes(required), `V3.4 email missing ${required}`);
}

const fundingEmail = renderFundingCarryV2PaperEmail({
  model_id: FUNDING_CARRY_V2_MODEL.id,
  model_version: FUNDING_CARRY_V2_MODEL.version,
  rebalance_time: "2026-08-28T00:00:00.000Z",
  targets: []
}, { performanceSnapshot: { modelLabel: "Funding Carry V2", completedPeriods: 7, compoundedReturn: -0.0418, basis: "Production PAPER 已完成周期" } });
for (const required of ["策略模型：Funding Carry V2", "已完成周期：7", "已完成周期复合收益：-4.18%", "统计口径：Production PAPER 已完成周期"]) {
  assert.ok(fundingEmail.text.includes(required), `Funding V2 email missing ${required}`);
}

for (const email of [dynamicEmail, v34Email, fundingEmail]) {
  assert.doesNotMatch(`${email.subject}\n${email.text}`, /NaN|Infinity|undefined|\[object Object\]/);
}

assert.deepEqual(
  buildSignalEmailPerformanceContext({ signals: [], historySignals: [] }),
  buildSignalPerformanceContextFallback(),
  "an empty email context must remain finite-safe and sample-free"
);

console.log("email performance context tests passed");

function buildSignalPerformanceContextFallback() {
  return {
    modelId: "legacy_signal",
    modelLabel: "旧版信号模型",
    strategyVersion: null,
    completedPeriods: 0,
    reviewedPeriods: 0,
    compoundedReturn: null,
    basis: "Production Forward 已完成复盘",
    sufficientData: false
  };
}
