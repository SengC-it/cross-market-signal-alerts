import {
  FROZEN_RANK_11_TO_25_QUALITY_POLICY,
  FROZEN_STRONG_EXTENSION_QUALITY_POLICY,
  isRank11To25EmailAuthorized,
  isStrongExtensionEmailAuthorized
} from "./signal-density-quality-policy.js";
import { STRONG_EXTENSION_VARIANT } from "./strategies/strong-extension.js";

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
  // Kept as a compatibility field, but generic OBSERVATION email is never
  // enabled by this policy.
  observationEmailEnabled: false,
  dynamicStrengthObservationEmailEnabled:
    process.env.SIGNAL_DYNAMIC_STRENGTH_OBSERVATION_EMAIL_ENABLED === "true"
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

export function classifyProductionSignal(signal = {}, {
  strongExtensionQualityPolicy = FROZEN_STRONG_EXTENSION_QUALITY_POLICY
} = {}) {
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

  if (strategyId === DYNAMIC_STRENGTH
    && signal.signalVariant === STRONG_EXTENSION_VARIANT) {
    const extensionPassed = strongExtensionQualityPolicy?.classification === "STRONG_OBSERVATION"
      && strongExtensionQualityPolicy?.failClosed !== true;
    if (!extensionPassed) {
      return {
        tier: SIGNAL_TIERS.SHADOW_ONLY,
        label: "SHADOW_ONLY / STRONG EXTENSION",
        deliveryMode: "SHADOW_ONLY",
        emailEligible: false,
        webRecorded: true,
        shadowRecorded: true,
        historicalSampleStatus: "SHADOW_OBSERVATION_ONLY / 固定质量门未通过",
        reason: "STRONG_EXTENSION_10_15 没有通过冻结质量 artifact 的 promotion gate，只保留 Web/影子记录。"
      };
    }
    return {
      tier: SIGNAL_TIERS.OBSERVATION,
      label: "STRONG EXTENSION / OBSERVATION",
      deliveryMode: "WEB",
      emailEligible: false,
      webRecorded: true,
      shadowRecorded: false,
      historicalSampleStatus: "NOT_VALIDATED_PROFITABILITY / 未验证盈利",
      reason: "STRONG EXTENSION 仅为观察级，未验证盈利能力；是否交易和风险管理均由人工决定。"
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

export function applyProductionSignalPolicy(signal = {}, options = {}) {
  const policy = classifyProductionSignal(signal, options);
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
  limit = 4,
  strengthObservationEmailEnabled,
  rank11To25QualityPolicy = FROZEN_RANK_11_TO_25_QUALITY_POLICY,
  strongExtensionQualityPolicy = FROZEN_STRONG_EXTENSION_QUALITY_POLICY,
  // Legacy callers may still pass this name. It is scoped to the dynamic
  // strength observation family below and can never authorize generic
  // observations, Weak, or research-only signals.
  observationEmailEnabled
} = {}) {
  const highQualitySignals = [];
  const observationSignals = [];
  const shadowOnlySignals = [];
  const researchOnlySignals = [];

  for (const candidate of candidates) {
    const signal = applyProductionSignalPolicy(candidate, { strongExtensionQualityPolicy });
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

  const strengthObservationEmailEnabledResolved = strengthObservationEmailEnabled
    ?? observationEmailEnabled
    ?? SIGNAL_ONLY_RELEASE.dynamicStrengthObservationEmailEnabled;
  const strongObservationSignals = observationSignals.filter(isDynamicStrengthObservation);
  const optionalObservationEmail = strengthObservationEmailEnabledResolved
    ? strongObservationSignals
      .filter((signal) => signal.signalVariant === STRONG_EXTENSION_VARIANT
        ? isStrongExtensionEmailAuthorized({
          strengthObservationEmailEnabled: strengthObservationEmailEnabledResolved,
          qualityPolicy: strongExtensionQualityPolicy
        })
        : !Number.isInteger(Number(signal.dynamicPoolRank))
          // Legacy dynamic-strength payloads predate pool-rank persistence;
          // they are treated as legacy Core, never as rank 11–25.
          ? true
        : isRank11To25EmailAuthorized({
          dynamicPoolRank: signal.dynamicPoolRank,
          strengthObservationEmailEnabled: strengthObservationEmailEnabledResolved,
          qualityPolicy: rank11To25QualityPolicy
        }))
      .map((signal) => forEmailDelivery(signal))
    : [];
  const emailEligibleSignals = [...highQualitySignals, ...optionalObservationEmail]
    .sort((a, b) => Number(b.recommendationScore || 0) - Number(a.recommendationScore || 0))
  const emailCandidates = emailEligibleSignals.slice(0, Math.max(0, Number(limit) || 0));
  const emailEligibleKeys = new Set(emailEligibleSignals.map((signal) => signal.signalKey));
  const webObservationSignals = observationSignals.filter((signal) => !emailEligibleKeys.has(signal.signalKey));

  return {
    highQualitySignals,
    strongObservationSignals,
    observationSignals: webObservationSignals,
    shadowOnlySignals,
    researchOnlySignals,
    emailEligibleSignals,
    emailCandidates,
    webSignals: webObservationSignals,
    eligibleHighQualitySignals: highQualitySignals.length,
    eligibleStrongObservations: strongObservationSignals.length,
    observationEmailEnabled: Boolean(strengthObservationEmailEnabledResolved),
    dynamicStrengthObservationEmailEnabled: Boolean(strengthObservationEmailEnabledResolved)
  };
}

export function isDynamicStrengthObservation(signal = {}) {
  return signal?.strategyId === "dynamic_relative_strength_breakout"
    && signal?.signalTier === SIGNAL_TIERS.OBSERVATION;
}

export function isDynamicStrengthExtensionObservation(signal = {}) {
  return isDynamicStrengthObservation(signal)
    && signal?.signalVariant === STRONG_EXTENSION_VARIANT;
}

export function markSignalAsWebOverflow(signal, reason = "email_capacity_overflow") {
  return {
    ...signal,
    delivery: {
      ...(signal.delivery || {}),
      mode: "WEB",
      emailSuppressed: true,
      suppressionReason: reason,
      webRecorded: true
    }
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
