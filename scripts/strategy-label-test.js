import assert from "node:assert/strict";
import {
  STRATEGY_DISPLAY_GROUPS,
  orderedStrategyGroups,
  strategyGroupForPaperRun,
  strategyGroupForSignal,
  strategyGroupLabelForSignal
} from "../lib/strategy-display-groups.js";
import { buildForwardStrategyPerformance } from "../lib/performance-summary.js";

const cases = [
  ["legacy dynamic strength", {
    strategy_id: "dynamic_relative_strength_breakout",
    model_version: "DYNAMIC_SPOT_V1_2025-01-01",
    payload: { signalVariant: "STRONG_EXTENSION_10_15" }
  }, "LEGACY PRODUCTION"],
  ["legacy dynamic weakness", {
    strategy_id: "dynamic_relative_weakness_breakdown",
    model_version: "DYNAMIC_SPOT_V1_2025-01-01",
    payload: {}
  }, "LEGACY PRODUCTION"],
  ["legacy momentum", {
    strategy_id: "short_term_momentum_24h",
    model_version: "LEGACY_MOMENTUM",
    payload: {}
  }, "LEGACY PRODUCTION"],
  ["legacy negative funding", {
    strategy_id: "perp_negative_funding_reverse_cash_carry",
    model_version: "LEGACY_FUNDING",
    payload: {}
  }, "LEGACY PRODUCTION"],
  ["V4 shadow", {
    strategy_id: "dynamic_relative_weakness_breakdown",
    model_version: "DYNAMIC_SPOT_V2_2026-08-01",
    payload: {}
  }, "V4 SHADOW"],
  ["V4.2", {
    strategy_id: "dynamic_relative_strength_breakout",
    model_version: "DYNAMIC_SPOT_V2_2026-08-01",
    payload: { signalVariant: "STRONG_EXTENSION_10_15" }
  }, "V4.2 FORWARD"],
  ["V3.1", { model_version: "V3.1 PAPER", payload: { delivery: { mode: "PAPER" } } }, "V3.1 FORWARD PAPER"],
  ["V3.3", { model_version: "V3.3 PAPER", payload: { delivery: { mode: "PAPER" } } }, "V3.3 FORWARD PAPER"],
  ["V3.4", { model_version: "V3.4 PAPER", payload: { delivery: { mode: "PAPER" } } }, "V3.4 FORWARD PAPER"],
  ["Funding Carry V2", {
    model_version: "FUNDING CARRY PERP Z-SCORE V2 PAPER",
    payload: { delivery: { mode: "PAPER" } }
  }, "FUNDING CARRY V2 FORWARD PAPER"]
];

for (const [name, signal, expectedLabel] of cases) {
  const group = strategyGroupForSignal(signal);
  assert.equal(group?.label, expectedLabel, `${name} mapping`);
  assert.equal(strategyGroupLabelForSignal(signal), expectedLabel, `${name} display label`);
}
assert.equal(
  strategyGroupForSignal({
    strategy_id: "dynamic_relative_strength_breakout",
    model_version: "DYNAMIC_SPOT_V2_2026-08-01",
    payload: { signalVariant: "STRONG_CORE_8_10" }
  }),
  null,
  "unlisted V4 core must not be relabeled as legacy production"
);
assert.equal(
  strategyGroupForSignal({ payload: { delivery: { mode: "SHADOW_ONLY" } } })?.label,
  "V4 SHADOW",
  "SHADOW_ONLY delivery must use the shared V4 shadow label"
);

const expectedLabels = [
  "V4.2 FORWARD",
  "V4 SHADOW",
  "FUNDING CARRY V2 FORWARD PAPER",
  "V3.4 FORWARD PAPER",
  "V3.3 FORWARD PAPER",
  "V3.1 FORWARD PAPER",
  "LEGACY PRODUCTION"
];
assert.deepEqual(
  STRATEGY_DISPLAY_GROUPS.map((group) => group.label),
  expectedLabels,
  "shared definitions must remain newest-first"
);

const paperModelIds = {
  "V3.1 FORWARD PAPER": "v3_1_residual_momentum_beta_neutral",
  "V3.3 FORWARD PAPER": "v3_3_vol_target_catastrophe_breaker",
  "V3.4 FORWARD PAPER": "v3_4_unified_residual_volatility_risk",
  "FUNDING CARRY V2 FORWARD PAPER": "funding_carry_perp_reversion_ema100_v2"
};
for (const [label, model_id] of Object.entries(paperModelIds)) {
  assert.equal(strategyGroupForPaperRun({ model_id })?.label, label, `${label} paper run mapping`);
}

const paperRuns = Object.values(paperModelIds).map((model_id, index) => ({
  model_id,
  email_status: "sent",
  email_sent_at: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  rebalance_time: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  targets: [{ symbol: "BTCUSDT" }],
  review: { status: "pending" }
}));
const performance = buildForwardStrategyPerformance({
  emailNotifications: cases.map(([, signal], index) => ({
    ...signal,
    signal_key: `strategy-test-${index}`,
    sent_at: "2026-08-28T00:00:00.000Z",
    payload: { ...(signal.payload || {}), review: { status: "pending" } }
  })),
  paperModelRuns: paperRuns
});
assert.deepEqual(
  orderedStrategyGroups(performance).map((group) => group.label),
  expectedLabels,
  "performance groups must render in fixed newest-first order"
);

console.log(`strategy group consistency tests passed (${cases.length} mappings, ${expectedLabels.length} ordered groups)`);
