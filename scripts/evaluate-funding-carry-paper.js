import { readFile, writeFile } from "node:fs/promises";
import {
  evaluateFundingCarryPaperGate,
  FUNDING_CARRY_MODEL
} from "../lib/funding-carry-paper.js";
import {
  fetchPaperModelRunsForModel,
  isSupabaseConfigured
} from "../lib/storage.js";

const INPUT_FILE = process.env.FUNDING_CARRY_PAPER_INPUT;
const OUTPUT_FILE = process.env.FUNDING_CARRY_PAPER_OUTPUT || "funding_carry_paper_gate_2026-08-02.json";
const REQUIRE_PASS = process.env.FUNDING_CARRY_PAPER_REQUIRE_PASS === "1";

async function loadRuns() {
  if (INPUT_FILE) {
    const parsed = JSON.parse(await readFile(INPUT_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("FUNDING_CARRY_PAPER_INPUT must be a JSON array of cr_paper_model_runs rows");
    return parsed;
  }
  if (!isSupabaseConfigured()) {
    throw new Error("Set FUNDING_CARRY_PAPER_INPUT or SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
  }
  return fetchPaperModelRunsForModel({
    modelId: FUNDING_CARRY_MODEL.id,
    beforeTime: Date.now() + 60_000,
    limit: 500
  });
}

const runs = await loadRuns();
const gate = evaluateFundingCarryPaperGate(runs);
const result = {
  generatedAt: new Date().toISOString(),
  modelId: FUNDING_CARRY_MODEL.id,
  modelVersion: FUNDING_CARRY_MODEL.version,
  source: INPUT_FILE || "Supabase cr_paper_model_runs",
  gate,
  deploymentGatePassed: gate.passed
};
await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  modelId: result.modelId,
  runs: Array.isArray(runs) ? runs.length : 0,
  deploymentGatePassed: result.deploymentGatePassed,
  metrics: gate.metrics,
  checks: gate.checks
}, null, 2));
if (REQUIRE_PASS && !gate.passed) process.exitCode = 1;
