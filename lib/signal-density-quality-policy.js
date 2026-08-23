import { existsSync, readFileSync } from "node:fs";

export const RANK_11_TO_25_EMAIL_CLASSIFICATION = "STRONG_OBSERVATION_EMAIL";
export const RANK_11_TO_25_SHADOW_CLASSIFICATION = "SHADOW_OBSERVATION_ONLY";

const QUALITY_ARTIFACT_URL = new URL(
  "../artifacts/v4/v4-1-signal-density-quality.json",
  import.meta.url
);
const STRONG_EXTENSION_QUALITY_ARTIFACT_URL = new URL(
  "../artifacts/v4/v4-2-strong-extension-quality.json",
  import.meta.url
);

export const STRONG_EXTENSION_EMAIL_CLASSIFICATION = "STRONG_OBSERVATION";
export const STRONG_EXTENSION_SHADOW_CLASSIFICATION = "SHADOW_OBSERVATION_ONLY";

export function resolveRank11To25QualityPolicy(artifact) {
  const classification = artifact?.rank11To25Policy?.classification;
  if (classification === RANK_11_TO_25_EMAIL_CLASSIFICATION) {
    return Object.freeze({
      classification,
      source: "frozen_artifact",
      failClosed: false
    });
  }
  if (classification === RANK_11_TO_25_SHADOW_CLASSIFICATION) {
    return Object.freeze({
      classification,
      source: "frozen_artifact",
      failClosed: false
    });
  }
  return Object.freeze({
    classification: RANK_11_TO_25_SHADOW_CLASSIFICATION,
    source: existsSync(QUALITY_ARTIFACT_URL) ? "invalid_frozen_artifact" : "missing_frozen_artifact",
    failClosed: true
  });
}

function loadFrozenQualityArtifact() {
  try {
    return JSON.parse(readFileSync(QUALITY_ARTIFACT_URL, "utf8"));
  } catch {
    return null;
  }
}

export const FROZEN_RANK_11_TO_25_QUALITY_POLICY = resolveRank11To25QualityPolicy(
  loadFrozenQualityArtifact()
);

export function resolveStrongExtensionQualityPolicy(artifact) {
  const classification = artifact?.extensionVerdict?.classification;
  if (classification === STRONG_EXTENSION_EMAIL_CLASSIFICATION) {
    return Object.freeze({
      classification,
      source: "frozen_artifact",
      failClosed: false
    });
  }
  if (classification === STRONG_EXTENSION_SHADOW_CLASSIFICATION) {
    return Object.freeze({
      classification,
      source: "frozen_artifact",
      failClosed: false
    });
  }
  return Object.freeze({
    classification: STRONG_EXTENSION_SHADOW_CLASSIFICATION,
    source: existsSync(STRONG_EXTENSION_QUALITY_ARTIFACT_URL)
      ? "invalid_frozen_artifact"
      : "missing_frozen_artifact",
    failClosed: true
  });
}

function loadFrozenStrongExtensionArtifact() {
  try {
    return JSON.parse(readFileSync(STRONG_EXTENSION_QUALITY_ARTIFACT_URL, "utf8"));
  } catch {
    return null;
  }
}

export const FROZEN_STRONG_EXTENSION_QUALITY_POLICY = resolveStrongExtensionQualityPolicy(
  loadFrozenStrongExtensionArtifact()
);

export function isRank11To25EmailAuthorized({
  dynamicPoolRank,
  strengthObservationEmailEnabled,
  qualityPolicy = FROZEN_RANK_11_TO_25_QUALITY_POLICY
} = {}) {
  if (!strengthObservationEmailEnabled) return false;
  const rank = Number(dynamicPoolRank);
  if (!Number.isInteger(rank)) return false;
  if (rank >= 1 && rank <= 10) return true;
  return rank >= 11
    && rank <= 25
    && qualityPolicy?.classification === RANK_11_TO_25_EMAIL_CLASSIFICATION
    && qualityPolicy?.failClosed !== true;
}

export function isStrongExtensionEmailAuthorized({
  strengthObservationEmailEnabled,
  qualityPolicy = FROZEN_STRONG_EXTENSION_QUALITY_POLICY
} = {}) {
  return Boolean(strengthObservationEmailEnabled)
    && qualityPolicy?.classification === STRONG_EXTENSION_EMAIL_CLASSIFICATION
    && qualityPolicy?.failClosed !== true;
}
