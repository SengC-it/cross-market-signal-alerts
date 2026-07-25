import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, "robust_alpha_periods_2026-07-25.json");
const OUTPUT = path.join(ROOT, "v3_beta_validation_2026-07-25.json");

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 8) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function regression(periods) {
  const observations = periods
    .map((period) => ({
      market: Number(period.benchmarkReturns?.baseline),
      strategy: Number(period.rawReturn)
    }))
    .filter((row) => Number.isFinite(row.market) && Number.isFinite(row.strategy));
  const market = observations.map((row) => row.market);
  const strategy = observations.map((row) => row.strategy);
  const marketMean = mean(market);
  const strategyMean = mean(strategy);
  const marketSquaredDeviation = market.reduce(
    (sum, value) => sum + (value - marketMean) ** 2,
    0
  );
  const strategySquaredDeviation = strategy.reduce(
    (sum, value) => sum + (value - strategyMean) ** 2,
    0
  );
  const covarianceNumerator = observations.reduce(
    (sum, row) =>
      sum + (row.market - marketMean) * (row.strategy - strategyMean),
    0
  );
  const beta = covarianceNumerator / marketSquaredDeviation;
  const alpha = strategyMean - beta * marketMean;
  const residuals = observations.map(
    (row) => row.strategy - alpha - beta * row.market
  );
  const residualVariance = residuals.reduce(
    (sum, value) => sum + value ** 2,
    0
  ) / Math.max(1, observations.length - 2);
  const alphaStandardError = Math.sqrt(
    residualVariance
      * (1 / observations.length + marketMean ** 2 / marketSquaredDeviation)
  );
  const correlation = covarianceNumerator
    / Math.sqrt(marketSquaredDeviation * strategySquaredDeviation);

  const longReturns = periods.map((period) =>
    period.positions
      .filter((position) => position.weight > 0)
      .reduce(
        (sum, position) => sum + position.weight * position.assetReturn,
        0
      )
  );
  const shortReturns = periods.map((period) =>
    period.positions
      .filter((position) => position.weight < 0)
      .reduce(
        (sum, position) => sum + position.weight * position.assetReturn,
        0
      )
  );

  return {
    observations: observations.length,
    weeklyAlpha: round(alpha),
    annualizedLinearAlpha: round(alpha * 52),
    alphaTStatistic: round(alpha / alphaStandardError),
    btcBeta: round(beta),
    correlation: round(correlation),
    rSquared: round(correlation ** 2),
    averageBtcReturn: round(marketMean),
    averageStrategyRawReturn: round(strategyMean),
    averageLongLegReturn: round(mean(longReturns)),
    averageShortLegReturn: round(mean(shortReturns)),
    sumLongLegReturn: round(longReturns.reduce((sum, value) => sum + value, 0)),
    sumShortLegReturn: round(shortReturns.reduce((sum, value) => sum + value, 0))
  };
}

const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const result = {
  generatedAt: new Date().toISOString(),
  fingerprint: source.fingerprint,
  note: "OLS uses weekly price returns before funding and trading costs",
  splits: Object.fromEntries(
    Object.entries(source.periodsBySplit).map(([name, periods]) => [
      name,
      regression(periods)
    ])
  )
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
