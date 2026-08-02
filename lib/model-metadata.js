import { createHash } from "node:crypto";
import { CONFIG } from "./config.js";

export const DYNAMIC_MODEL_VERSION = "DYNAMIC_SPOT_V2_2026-08-01";
const DEFAULT_MODEL_VERSION = "SCANNER_STRATEGY_V1";
export const DEPLOYMENT_COMMIT = String(
  process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.GIT_COMMIT_SHA
    || "unknown"
);

const DYNAMIC_CONFIG_KEYS = [
  "relativeStrengthMinMomentum24h",
  "relativeStrengthMaxMomentum24h",
  "relativeStrengthMinRelativeStrength24h",
  "relativeStrengthMinVolumeMultiple",
  "relativeStrengthMaxVolumeMultiple",
  "relativeWeaknessMaxMomentum24h",
  "relativeWeaknessMinMomentum24h",
  "relativeWeaknessMaxRelativeStrength24h",
  "relativeWeaknessMinVolumeMultiple",
  "relativeWeaknessMaxVolumeMultiple",
  "dynamicTradeMinRecommendationScore",
  "dynamicObservationMaxScore",
  "assetSignalCooldownHours",
  "futuresTradingCost"
];

const DYNAMIC_STRATEGY_FAMILIES = Object.freeze({
  dynamic_relative_strength_breakout: "dynamic_strength",
  dynamic_relative_weakness_breakdown: "dynamic_weakness"
});

export function dynamicModelConfigSnapshot() {
  return pickConfig(CONFIG, DYNAMIC_CONFIG_KEYS);
}

export function dynamicStrategyFamily(strategyId) {
  return DYNAMIC_STRATEGY_FAMILIES[strategyId] || null;
}

export function buildModelMetadata({
  modelVersion,
  modelFamily,
  configSnapshot = {},
  codeCommit = DEPLOYMENT_COMMIT
}) {
  const normalizedVersion = String(modelVersion || "unversioned");
  const normalizedFamily = String(modelFamily || "unknown");
  const normalizedCommit = String(codeCommit || "unknown");
  const config = stableCopy(configSnapshot);
  const configHash = shortHash(canonicalJson(config));
  const fingerprint = shortHash(canonicalJson({
    codeCommit: normalizedCommit,
    configHash,
    modelFamily: normalizedFamily,
    modelVersion: normalizedVersion
  }));

  return Object.freeze({
    modelVersion: normalizedVersion,
    modelFamily: normalizedFamily,
    configHash,
    fingerprint,
    codeCommit: normalizedCommit,
    config
  });
}

export function withModelMetadata(signal, options = {}) {
  const modelVersion = options.modelVersion || signal?.modelVersion || DEFAULT_MODEL_VERSION;
  const modelFamily = options.modelFamily
    || dynamicStrategyFamily(signal?.strategyId)
    || `strategy:${signal?.strategyId || "unknown"}`;
  const metadata = buildModelMetadata({
    modelVersion,
    modelFamily,
    configSnapshot: options.configSnapshot || {},
    codeCommit: options.codeCommit
  });

  return {
    ...signal,
    modelVersion: metadata.modelVersion,
    modelFamily: metadata.modelFamily,
    modelFingerprint: metadata.fingerprint,
    codeCommit: metadata.codeCommit,
    modelMetadata: metadata
  };
}

export function getSignalModelMetadata(signal) {
  const existing = signal?.modelMetadata;
  if (existing?.fingerprint && existing?.modelVersion && existing?.modelFamily) {
    return existing;
  }
  return buildModelMetadata({
    modelVersion: signal?.modelVersion || DEFAULT_MODEL_VERSION,
    modelFamily: signal?.modelFamily
      || dynamicStrategyFamily(signal?.strategyId)
      || `strategy:${signal?.strategyId || "unknown"}`,
    configSnapshot: signal?.modelConfig || {}
  });
}

function pickConfig(config, keys) {
  return Object.fromEntries(keys.map((key) => [key, config[key]]));
}

function stableCopy(value) {
  if (Array.isArray(value)) return value.map(stableCopy);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableCopy(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
