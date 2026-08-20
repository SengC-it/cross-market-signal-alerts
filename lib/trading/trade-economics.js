import {
  applyEntryExecution,
  applyExitExecution,
  COMPLETE_DATA_QUALITY,
  createExecutionModel,
  INCOMPLETE_EXCHANGE_FILTERS,
  INCOMPLETE_FUNDING,
  validateFundingCoverageForTrade,
  feePctForLeg
} from "../backtest/execution-model.js";
import { normalizeExchangeFilters } from "./exchange-filters.js";

export const MODELED_EXECUTION = "MODELED_EXECUTION";

export function calculateTradeEconomics({
  tradeSpec,
  entryExecution,
  exitExecution,
  exitTime,
  executionModel = createExecutionModel(),
  intrabarQuality = "BASE_BAR_REPLAY",
  exchangeFilters = null,
  exchangeRulesRequired = executionModel?.exchangeRulesRequired !== false
} = {}) {
  const entryMarketPrice = Number(entryExecution?.marketPrice);
  const entryFillPrice = Number(entryExecution?.fillPrice);
  const exitMarketPrice = Number(exitExecution?.marketPrice);
  const exitFillPrice = Number(exitExecution?.fillPrice);
  const spreadOnlyModel = {
    ...executionModel,
    entrySlippagePct: 0,
    exitSlippagePct: 0
  };
  const spreadOnlyEntry = applyEntryExecution({
    marketPrice: entryMarketPrice,
    side: tradeSpec?.side,
    executionModel: spreadOnlyModel
  });
  const spreadOnlyExit = applyExitExecution({
    marketPrice: exitMarketPrice,
    side: tradeSpec?.side,
    executionModel: spreadOnlyModel
  });
  const grossReturnPct = directionalReturn(entryMarketPrice, exitMarketPrice, tradeSpec?.side);
  const spreadAdjustedReturnPct = directionalReturn(
    spreadOnlyEntry.fillPrice,
    spreadOnlyExit.fillPrice,
    tradeSpec?.side
  );
  const fillReturnPct = directionalReturn(entryFillPrice, exitFillPrice, tradeSpec?.side);
  const spreadCostPct = finiteDifference(grossReturnPct, spreadAdjustedReturnPct);
  const slippageCostPct = finiteDifference(spreadAdjustedReturnPct, fillReturnPct);
  const entryFeeRate = feePctForLeg(executionModel, "entry");
  const exitFeeRate = feePctForLeg(executionModel, "exit");
  const entryFeePct = entryFeeRate;
  const exitFeePct = Number.isFinite(entryFillPrice) && entryFillPrice !== 0
    ? exitFeeRate * exitFillPrice / entryFillPrice
    : null;
  const totalFeePct = Number.isFinite(entryFeePct) && Number.isFinite(exitFeePct)
    ? entryFeePct + exitFeePct
    : null;
  const funding = executionModel?.marketType === "futures"
    ? validateFundingCoverageForTrade({
      fundingCoverage: executionModel.fundingCoverage,
      entryTime: entryExecution?.entryTime,
      exitTime
    })
    : { valid: true, status: "NOT_APPLICABLE", reason: null };
  const fundingPct = fundingReturn({
    side: tradeSpec?.side,
    entryTime: Number(entryExecution?.entryTime),
    exitTime: Number(exitTime),
    executionModel
  });
  const components = buildDataQualityComponents({
    executionModel,
    fundingStatus: funding.status,
    intrabarQuality,
    exchangeFilters,
    exchangeRulesRequired
  });
  const dataQuality = resolveOverallDataQuality(components);
  const initialRiskPct = initialRisk(tradeSpec?.side, entryFillPrice, tradeSpec?.stopLoss);
  const netReturnPct = Number.isFinite(fillReturnPct) && Number.isFinite(totalFeePct)
    ? fillReturnPct - totalFeePct + fundingPct
    : null;

  return {
    grossReturnPct,
    entryFeePct,
    exitFeePct,
    entryFeeRate,
    exitFeeRate,
    totalFeePct,
    spreadCostPct,
    slippageCostPct,
    fundingPct,
    netReturnPct,
    initialRiskPct,
    realizedR: Number.isFinite(initialRiskPct) && initialRiskPct > 0 && Number.isFinite(netReturnPct)
      ? netReturnPct / initialRiskPct
      : null,
    dataQuality,
    dataQualityComponents: components,
    fundingStatus: funding.status,
    fundingCoverage: executionModel?.fundingCoverage || null
  };
}

export function buildDataQualityComponents({
  executionModel,
  fundingStatus,
  intrabarQuality = "BASE_BAR_REPLAY",
  exchangeFilters = null,
  exchangeRulesRequired = executionModel?.exchangeRulesRequired !== false
} = {}) {
  const normalizedExchangeFilters = normalizeExchangeFilters(exchangeFilters);
  const exchangeQuality = exchangeRulesRequired
    ? normalizedExchangeFilters ? COMPLETE_DATA_QUALITY : INCOMPLETE_EXCHANGE_FILTERS
    : normalizedExchangeFilters ? COMPLETE_DATA_QUALITY : "NOT_APPLICABLE";
  return Object.freeze({
    funding: executionModel?.marketType === "futures"
      ? fundingStatus || INCOMPLETE_FUNDING
      : "NOT_APPLICABLE",
    intrabar: intrabarQuality || "INCOMPLETE_INTRABAR_DATA",
    exchangeFilters: exchangeQuality,
    execution: MODELED_EXECUTION
  });
}

export function resolveOverallDataQuality(components = {}) {
  if (components.funding === INCOMPLETE_FUNDING) return INCOMPLETE_FUNDING;
  if (components.exchangeFilters === INCOMPLETE_EXCHANGE_FILTERS) return INCOMPLETE_EXCHANGE_FILTERS;
  if (components.intrabar === "INCOMPLETE_INTRABAR_DATA") return "INCOMPLETE_INTRABAR_DATA";
  return COMPLETE_DATA_QUALITY;
}

export function fundingReturn({ side, entryTime, exitTime, executionModel } = {}) {
  if (!executionModel || !Array.isArray(executionModel.fundingEvents)) return 0;
  return executionModel.fundingEvents
    .filter((event) => event.time > entryTime && event.time <= exitTime)
    .reduce((total, event) => total + (side === "LONG" ? -event.rate : event.rate), 0);
}

function directionalReturn(entryPrice, exitPrice, side) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice === 0) return null;
  const raw = exitPrice / entryPrice - 1;
  return side === "SHORT" ? -raw : raw;
}

function initialRisk(side, entryPrice, stopLoss) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(Number(stopLoss)) || entryPrice === 0) return null;
  return Math.abs(entryPrice - Number(stopLoss)) / entryPrice;
}

function finiteDifference(first, second) {
  return Number.isFinite(first) && Number.isFinite(second) ? first - second : null;
}
