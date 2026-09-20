import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const dashboardSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = dashboardSource.indexOf("      function strategyLabel(alert) {");
const end = dashboardSource.indexOf("      function renderAlertCard", start);
assert.ok(start >= 0 && end > start, "strategyLabel must remain defined in index.html");

const context = {};
vm.runInNewContext(`${dashboardSource.slice(start, end)}\nglobalThis.strategyLabel = strategyLabel;`, context);

const cases = [
  ["V4.2 extension", {
    strategy_id: "dynamic_relative_strength_breakout",
    model_version: "DYNAMIC_SPOT_V2_2026-08-01",
    payload: { signalVariant: "STRONG_EXTENSION_10_15" }
  }, "V4.2"],
  ["V4 core", {
    strategy_id: "dynamic_relative_strength_breakout",
    model_version: "DYNAMIC_SPOT_V2_2026-08-01",
    payload: { signalVariant: "STRONG_CORE_8_10" }
  }, "V4"],
  ["V4 shadow", {
    strategy_id: "dynamic_relative_weakness_breakdown",
    payload: {}
  }, "V4 Shadow"],
  ["V3.4", { model_version: "V3.4 PAPER", payload: {} }, "V3.4"],
  ["Funding Carry V2", {
    model_version: "FUNDING CARRY PERP Z-SCORE V2 REVERSION EMA100 PAPER",
    payload: {}
  }, "Funding Carry V2"],
  ["Funding Carry", { model_version: "FUNDING CARRY PERP V1", payload: {} }, "Funding Carry"],
  ["V3.x", { model_version: "V3.3 PAPER", payload: {} }, "V3.3"],
  ["legacy fallback", { model_version: "DYNAMIC_SPOT_V2_2026-08-01", payload: {} }, "旧版"]
];

for (const [name, alert, expected] of cases) {
  assert.equal(context.strategyLabel(alert), expected, `${name} mapping`);
}

console.log(`strategy label tests passed (${cases.length} mappings)`);
