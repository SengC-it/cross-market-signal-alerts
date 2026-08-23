export const SIGNAL_ONLY_RELEASE = Object.freeze({
  name: "V4 SIGNAL-ONLY PRODUCTION",
  systemType: "人工决策的合约信号提醒与人工决策辅助系统",
  autoTrading: false,
  orderPlacement: false,
  positionManagement: false,
  referenceRiskOnly: true,
  duplicateSignalProtection: true,
  processedCandleProtection: true,
  currentPriceGuard: true,
  observationEmailEnabled: process.env.SIGNAL_OBSERVATION_EMAIL_ENABLED === "true"
});

export const SIGNAL_TIERS = Object.freeze({
  TRADE_WATCH: "TRADE_WATCH",
  OBSERVATION: "OBSERVATION",
  SHADOW_ONLY: "SHADOW_ONLY",
  RESEARCH_ONLY: "RESEARCH_ONLY"
});

export const M37_REJECTED_STRATEGY_IDS = Object.freeze([
  "cross_sectional_relative_momentum_v1",
  "atr_dislocation_mean_reversion_v1",
  "funding_extreme_crowding_reversal_v1"
]);

const M37_REJECTED = new Set(M37_REJECTED_STRATEGY_IDS);
const DYNAMIC_WEAKNESS = "dynamic_relative_weakness_breakdown";
const DYNAMIC_STRENGTH = "dynamic_relative_strength_breakout";

export function classifyProductionSignal(signal = {}) {
  const strategyId = signal.strategyId || signal.strategy_id || null;
  if (M37_REJECTED.has(strategyId)) {
    return {
      tier: SIGNAL_TIERS.RESEARCH_ONLY,
      label: "RESEARCH_ONLY / 已冻结研究",
      deliveryMode: "NONE",
      emailEligible: false,
      webRecorded: false,
      shadowRecorded: false,
      historicalSampleStatus: "M3.7 REJECTED_CANDIDATE",
      reason: "该研究 family 已被正式 research artifact 拒绝，不进入生产 scanner alert candidates。"
    };
  }

  if (strategyId === DYNAMIC_WEAKNESS) {
    return {
      tier: SIGNAL_TIERS.SHADOW_ONLY,
      label: "SHADOW_ONLY / 影子记录",
      deliveryMode: "SHADOW_ONLY",
      emailEligible: false,
      webRecorded: true,
      shadowRecorded: true,
      historicalSampleStatus: "NEGATIVE_EDGE / 已知负 edge",
      reason: "动态弱势策略已有负 edge，只记录，不发送普通交易提醒。"
    };
  }

  const isTradeTier = signal.alertTier === "trade";
  const isDynamicStrength = strategyId === DYNAMIC_STRENGTH;
  return {
    tier: isTradeTier ? SIGNAL_TIERS.TRADE_WATCH : SIGNAL_TIERS.OBSERVATION,
    label: isTradeTier
      ? "TRADE_WATCH / 高质量人工关注"
      : "OBSERVATION / 观察级",
    deliveryMode: isTradeTier ? "EMAIL" : "WEB",
    emailEligible: isTradeTier,
    webRecorded: true,
    shadowRecorded: false,
    historicalSampleStatus: isDynamicStrength
      ? "NOT_VALIDATED_PROFITABILITY / 未验证盈利"
      : "历史样本仅供参考，未构成盈利保证",
    reason: isDynamicStrength
      ? "动态强势信号可作为人工关注或观察，不宣称已验证盈利。"
      : isTradeTier
        ? "通过现有生产信号质量层，仍需人工判断是否交易。"
        : "证据不足以进入高质量人工关注队列，仅作观察。"
  };
}

export function applyProductionSignalPolicy(signal = {}) {
  const policy = classifyProductionSignal(signal);
  const deliveryMode = policy.deliveryMode;
  const emailSuppressed = !policy.emailEligible;
  const delivery = {
    ...(signal.delivery || {}),
    mode: deliveryMode,
    emailSuppressed,
    webRecorded: policy.webRecorded,
    shadowRecorded: policy.shadowRecorded,
    suppressionReason: emailSuppressed ? policy.tier.toLowerCase() : null,
    autoTrading: false,
    orderPlacement: false,
    positionManagement: false
  };

  return {
    ...signal,
    signalTier: policy.tier,
    signalTierLabel: policy.label,
    historicalSampleStatus: policy.historicalSampleStatus,
    referenceRiskOnly: true,
    humanDecisionRequired: true,
    productionPolicyReason: policy.reason,
    delivery
  };
}

export function routeSignalsByProductionPolicy({
  candidates = [],
  limit = 2,
  observationEmailEnabled = SIGNAL_ONLY_RELEASE.observationEmailEnabled
} = {}) {
  const highQualitySignals = [];
  const observationSignals = [];
  const shadowOnlySignals = [];
  const researchOnlySignals = [];

  for (const candidate of candidates) {
    const signal = applyProductionSignalPolicy(candidate);
    if (signal.signalTier === SIGNAL_TIERS.RESEARCH_ONLY) {
      researchOnlySignals.push(signal);
    } else if (signal.signalTier === SIGNAL_TIERS.SHADOW_ONLY) {
      shadowOnlySignals.push(signal);
    } else if (signal.signalTier === SIGNAL_TIERS.TRADE_WATCH) {
      highQualitySignals.push(signal);
    } else {
      observationSignals.push(signal);
    }
  }

  const optionalObservationEmail = observationEmailEnabled
    ? observationSignals.map((signal) => forEmailDelivery(signal))
    : [];
  const emailCandidates = [...highQualitySignals, ...optionalObservationEmail]
    .sort((a, b) => Number(b.recommendationScore || 0) - Number(a.recommendationScore || 0))
    .slice(0, Math.max(0, Number(limit) || 0));
  const emailedKeys = new Set(emailCandidates.map((signal) => signal.signalKey));
  const webObservationSignals = observationSignals.filter((signal) => !emailedKeys.has(signal.signalKey));

  return {
    highQualitySignals,
    observationSignals: webObservationSignals,
    shadowOnlySignals,
    researchOnlySignals,
    emailCandidates,
    observationEmailEnabled: Boolean(observationEmailEnabled)
  };
}

export function isSignalOnlyExecutionPath(value) {
  return value?.autoTrading === false
    && value?.orderPlacement === false
    && value?.positionManagement === false;
}

function forEmailDelivery(signal) {
  return {
    ...signal,
    delivery: {
      ...(signal.delivery || {}),
      mode: "EMAIL",
      emailSuppressed: false,
      suppressionReason: null
    }
  };
}
