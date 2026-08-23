export function directionalReturn(entryPrice, exitPrice, side = "LONG") {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return null;
  return String(side).toUpperCase() === "SHORT" ? entry / exit - 1 : exit / entry - 1;
}

export function summarizeRankQuality(samples = [], {
  tradingCost = 0.0012,
  foldCount = 5
} = {}) {
  const complete = samples.filter((sample) => (
    Number.isFinite(sample.return1h)
    && Number.isFinite(sample.return4h)
    && Number.isFinite(sample.return8h)
  ));
  const net4h = complete.map((sample) => sample.return4h - tradingCost);
  const net8h = complete.map((sample) => sample.return8h - tradingCost);
  const folds = Array.from({ length: foldCount }, (_, index) => {
    const foldSamples = complete.filter((sample) => Number(sample.fold) === index);
    const foldNet4h = foldSamples.map((sample) => sample.return4h - tradingCost);
    return {
      fold: index + 1,
      signals: foldSamples.length,
      netExpectancy4h: average(foldNet4h),
      positive: foldNet4h.length > 0 && average(foldNet4h) > 0
    };
  });

  return {
    signals: samples.length,
    completeSignals: complete.length,
    signalsPerMonth: samples.length ? samples.length / 6 : 0,
    positiveRate1h: positiveRate(complete.map((sample) => sample.return1h)),
    positiveRate4h: positiveRate(complete.map((sample) => sample.return4h)),
    positiveRate8h: positiveRate(complete.map((sample) => sample.return8h)),
    avgDirectionalReturn1h: average(complete.map((sample) => sample.return1h)),
    avgDirectionalReturn4h: average(complete.map((sample) => sample.return4h)),
    avgDirectionalReturn8h: average(complete.map((sample) => sample.return8h)),
    medianDirectionalReturn4h: median(complete.map((sample) => sample.return4h)),
    medianDirectionalReturn8h: median(complete.map((sample) => sample.return8h)),
    pf4h: profitFactor(net4h),
    pf8h: profitFactor(net8h),
    mae8h: average(complete.map((sample) => sample.mae8h)),
    mfe8h: average(complete.map((sample) => sample.mfe8h)),
    avgNetDirectionalReturn4h: average(net4h),
    avgNetDirectionalReturn8h: average(net8h),
    positiveResearchFolds: folds.filter((fold) => fold.positive).length,
    folds
  };
}

export function classifyRank11To25(summary = {}) {
  const passes = Number(summary.completeSignals) >= 30
    && Number(summary.avgNetDirectionalReturn4h) > 0
    && Number(summary.avgNetDirectionalReturn8h) > 0
    && Number(summary.pf4h) >= 1.10
    && Number(summary.pf8h) >= 1.10
    && Number(summary.positiveResearchFolds) >= 3;
  return {
    classification: passes ? "STRONG_OBSERVATION_EMAIL" : "SHADOW_OBSERVATION_ONLY",
    gates: {
      completeSignals: Number(summary.completeSignals) >= 30,
      net4hPositive: Number(summary.avgNetDirectionalReturn4h) > 0,
      net8hPositive: Number(summary.avgNetDirectionalReturn8h) > 0,
      pf4hAtLeast110: Number(summary.pf4h) >= 1.10,
      pf8hAtLeast110: Number(summary.pf8h) >= 1.10,
      positiveResearchFoldsAtLeast3: Number(summary.positiveResearchFolds) >= 3
    }
  };
}

function positiveRate(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.filter((value) => value > 0).length / finite.length : null;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function profitFactor(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const gains = finite.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = finite.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  if (!losses) return gains > 0 ? Infinity : null;
  return gains / losses;
}
