const V42_MODEL_ID = "DYNAMIC_SPOT_V2_2026-08-01";
const V42_STRENGTH_STRATEGY_ID = "dynamic_relative_strength_breakout";
const V42_SHADOW_STRATEGY_ID = "dynamic_relative_weakness_breakdown";

const PAPER_MODEL_IDS = Object.freeze({
  v3_1_forward_paper: "v3_1_residual_momentum_beta_neutral",
  v3_3_forward_paper: "v3_3_vol_target_catastrophe_breaker",
  v3_4_forward_paper: "v3_4_unified_residual_volatility_risk",
  funding_carry_v2_forward_paper: "funding_carry_perp_reversion_ema100_v2"
});

export const STRATEGY_DISPLAY_GROUPS = Object.freeze([
  Object.freeze({ id: "v4_2_forward", key: "v42Forward", label: "V4.2 FORWARD", order: 10 }),
  Object.freeze({ id: "v4_shadow", key: "v4Shadow", label: "V4 SHADOW", order: 20 }),
  Object.freeze({
    id: "funding_carry_v2_forward_paper",
    key: "fundingCarryV2ForwardPaper",
    label: "FUNDING CARRY V2 FORWARD PAPER",
    order: 30
  }),
  Object.freeze({ id: "v3_4_forward_paper", key: "v34ForwardPaper", label: "V3.4 FORWARD PAPER", order: 40 }),
  Object.freeze({ id: "v3_3_forward_paper", key: "v33ForwardPaper", label: "V3.3 FORWARD PAPER", order: 50 }),
  Object.freeze({ id: "v3_1_forward_paper", key: "v31ForwardPaper", label: "V3.1 FORWARD PAPER", order: 60 }),
  Object.freeze({ id: "legacy_production", key: "legacyProduction", label: "LEGACY PRODUCTION", order: 70 })
]);

const GROUP_BY_ID = new Map(STRATEGY_DISPLAY_GROUPS.map((group) => [group.id, group]));

export function orderedStrategyGroups(groups = {}) {
  return [...STRATEGY_DISPLAY_GROUPS]
    .sort((left, right) => left.order - right.order)
    .map((definition) => groups[definition.key] || groups[definition.id])
    .filter(Boolean);
}

export function strategyGroupForSignal(signal = {}) {
  const payload = signal?.payload || {};
  const modelVersion = firstText(
    signal?.model_version,
    signal?.modelVersion,
    payload.modelVersion
  );
  const strategyId = firstText(
    signal?.strategy_id,
    signal?.strategyId,
    payload.strategyId
  );
  const signalVariant = firstText(signal?.signalVariant, payload.signalVariant);

  if (isResearchOrSuppressed(signal)) return null;

  if (
    modelVersion === V42_MODEL_ID
    && strategyId === V42_STRENGTH_STRATEGY_ID
    && signalVariant === "STRONG_EXTENSION_10_15"
    && !isPaperSignal(signal)
    && !isShadowOnly(signal)
  ) {
    return GROUP_BY_ID.get("v4_2_forward");
  }

  if (
    isShadowOnly(signal)
    || (strategyId === V42_SHADOW_STRATEGY_ID && modelVersion === V42_MODEL_ID)
  ) {
    return GROUP_BY_ID.get("v4_shadow");
  }

  const paperGroup = paperGroupForRecord(signal);
  if (paperGroup) return paperGroup;
  if (isPaperSignal(signal)) return null;
  if (modelVersion === V42_MODEL_ID) return null;

  return GROUP_BY_ID.get("legacy_production");
}

export function strategyGroupForPaperRun(run = {}) {
  return paperGroupForRecord(run);
}

export function strategyGroupLabelForSignal(signal = {}) {
  return strategyGroupForSignal(signal)?.label || "未归组";
}

function paperGroupForRecord(record = {}) {
  const payload = record?.payload || {};
  const modelId = firstText(record?.model_id, record?.modelId, payload.modelId);
  const modelVersion = firstText(
    record?.model_version,
    record?.modelVersion,
    payload.modelVersion
  );
  const modelText = `${modelId || ""} ${modelVersion || ""}`.toUpperCase();
  const isPaperRecord = Boolean(modelId)
    || isPaperSignal(record)
    || /PAPER/.test(modelText);
  if (!isPaperRecord) return null;

  if (modelId === PAPER_MODEL_IDS.v3_1_forward_paper || /V3\.1\b/.test(modelText)) {
    return GROUP_BY_ID.get("v3_1_forward_paper");
  }
  if (modelId === PAPER_MODEL_IDS.v3_3_forward_paper || /V3\.3\b/.test(modelText)) {
    return GROUP_BY_ID.get("v3_3_forward_paper");
  }
  if (modelId === PAPER_MODEL_IDS.v3_4_forward_paper || /V3\.4\b/.test(modelText)) {
    return GROUP_BY_ID.get("v3_4_forward_paper");
  }
  if (
    modelId === PAPER_MODEL_IDS.funding_carry_v2_forward_paper
    || /FUNDING CARRY.*V2/.test(modelText)
  ) {
    return GROUP_BY_ID.get("funding_carry_v2_forward_paper");
  }
  return null;
}

function isPaperSignal(signal = {}) {
  const payload = signal?.payload || {};
  const deliveryMode = firstText(
    signal?.delivery_mode,
    signal?.delivery?.mode,
    payload.delivery?.mode
  );
  return String(signal?.signal_key || signal?.signalKey || "").startsWith("paper:")
    || String(deliveryMode || "").toUpperCase() === "PAPER";
}

function isShadowOnly(signal = {}) {
  const payload = signal?.payload || {};
  const deliveryMode = firstText(
    signal?.delivery_mode,
    signal?.delivery?.mode,
    payload.delivery?.mode
  );
  const signalTier = firstText(signal?.signalTier, payload.signalTier);
  return String(deliveryMode || "").toUpperCase() === "SHADOW_ONLY"
    || String(signalTier || "").toUpperCase() === "SHADOW_ONLY";
}

function isResearchOrSuppressed(signal = {}) {
  const payload = signal?.payload || {};
  const signalTier = firstText(signal?.signalTier, payload.signalTier);
  return String(signalTier || "").toUpperCase() === "RESEARCH_ONLY"
    || (isPaperSignal(signal) && payload.delivery?.emailSuppressed === true);
}

function firstText(...values) {
  for (const value of values) {
    if (value != null && value !== "" && typeof value !== "object") return String(value);
  }
  return null;
}
