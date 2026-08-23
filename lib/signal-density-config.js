export const SIGNAL_DENSITY_CONFIG = Object.freeze({
  maxSignalsPerEmail: Number(process.env.MAX_SIGNALS_PER_EMAIL || 4),
  dynamicStrongPoolMaxAssets: Number(process.env.DYNAMIC_STRONG_POOL_MAX_ASSETS || 25)
});
