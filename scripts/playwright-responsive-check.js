async (page) => {
  await page.evaluate(() => {
    const metrics = (id, label, scope, unit, signals, periods, reviewed, pending, wins, losses, averageNetReturn, netReturn, profitFactor, maxDrawdown) => ({
      id, label, scope, unit, signals, periods, reviewed, pending, wins, losses, flat: 0,
      winRate: wins + losses ? wins / (wins + losses) : null,
      averageNetReturn, netReturn, profitFactor, maxDrawdown,
      dataCompleteness: reviewed ? 1 : null,
      firstSignalAt: "2026-05-19T00:00:00Z",
      latestSignalAt: "2026-08-28T00:00:00Z"
    });
    renderPerformanceSummary({
      totalSignals: 283, reviewedSignals: 276, pendingSignals: 7, reviewRate: 276 / 283,
      profitSignals: 104, lossSignals: 172, flatSignals: 0, winRate: 104 / 276,
      totalAssets: 132, profitableAssets: 63, netSignalReturn: -0.07,
      averageSignalReturn: -0.00025, profitFactor: 0.877,
      reviewedPaperRuns: 17, profitablePaperRuns: 6, losingPaperRuns: 11,
      paperPortfolioReturn: -0.04, calculatedAt: "2026-08-29T13:00:00Z",
      strategyPerformance: {
        legacyProduction: metrics("legacy_production", "LEGACY PRODUCTION", "旧 scanner 实际历史邮件", "signals", 224, null, 224, 0, 82, 142, -0.0024, -0.55, 0.873, -0.53),
        v42Forward: metrics("v4_2_forward", "V4.2 FORWARD", "dynamic_relative_strength_breakout / STRONG_EXTENSION_10_15", "signals", 2, null, 0, 2, 0, 0, null, null, null, null),
        v34ForwardPaper: metrics("v3_4_forward_paper", "V3.4 FORWARD PAPER", "v3_4_unified_residual_volatility_risk", "periods", 24, 4, 3, 1, 1, 2, -0.018, -0.056, 0.48, -0.095),
        fundingCarryV2ForwardPaper: metrics("funding_carry_v2_forward_paper", "FUNDING CARRY V2 FORWARD PAPER", "funding_carry_perp_reversion_ema100_v2", "periods", 10, 10, 10, 0, 3, 7, 0.000034, 0.000344, 1.275, -0.000888)
      },
      forwardPromotionGate: { status: "INSUFFICIENT_FORWARD_SAMPLE", reviewedSignals: 0, minimumReviewedSignals: 30 }
    });
    renderAlertsV2([
      {
        signal_key: "long", asset: "BTCUSDT", sent_at: "2026-08-29T09:15:00Z",
        model_version: "DYNAMIC_SPOT_V2_2026-08-01",
        payload: {
          signalTier: "OBSERVATION", alertTierLabel: "STRONG EXTENSION / OBSERVATION", direction: "LONG",
          referencePrice: 112450, currentPrice: 111980, priceDriftPct: -0.0042,
          triggerReason: "极长原因 ".repeat(100), invalidCondition: "极长失效条件 ".repeat(100),
          review: { status: "pending", returnPct: -0.0031, reason: "监控中" }
        }
      },
      {
        signal_key: "short", asset: "ETHUSDT", sent_at: "2026-08-28T09:15:00Z", model_version: "V3.4 PAPER",
        payload: {
          alertTierLabel: "UNIFIED PAPER 验证", direction: "SHORT", referencePrice: 4000, currentPrice: 3900,
          priceDriftPct: -0.025,
          executionPlan: { kind: "v3_paper_position", targetWeight: -0.2, referencePrice: 4000, catastropheStopPct: 0.12, maxHoldingHours: 168, takeProfit: null },
          review: { status: "reviewed", returnPct: 0.02, outcome: "盈利" }
        }
      }
    ]);
  });

  const results = [];
  for (const width of [1440, 1024, 920, 900, 841, 840, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator(".signal-item").evaluateAll((items) => items.forEach((item) => { item.open = false; }));
    const closed = await page.evaluate(() => {
      const feed = document.querySelector(".signal-feed");
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        feedOverflow: feed.scrollWidth > feed.clientWidth,
        detailsVisible: [...document.querySelectorAll(".signal-more")].every((item) => item.getBoundingClientRect().right <= document.documentElement.clientWidth)
      };
    });
    await page.locator(".signal-item").evaluateAll((items) => items.forEach((item) => { item.open = true; }));
    const open = await page.evaluate(() => {
      const feed = document.querySelector(".signal-feed");
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        feedOverflow: feed.scrollWidth > feed.clientWidth
      };
    });
    const passed = !closed.documentOverflow && !closed.feedOverflow && closed.detailsVisible && !open.documentOverflow && !open.feedOverflow;
    if (!passed) throw new Error(`responsive overflow at ${width}px: ${JSON.stringify({ closed, open })}`);
    results.push({ width, closed, open, passed });
  }
  return results;
}
