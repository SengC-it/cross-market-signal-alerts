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
    const performanceFixture = {
      totalSignals: 283, reviewedSignals: 276, pendingSignals: 7, reviewRate: 276 / 283,
      profitSignals: 104, lossSignals: 172, flatSignals: 0, winRate: 104 / 276,
      totalAssets: 132, profitableAssets: 63, netSignalReturn: -0.07,
      averageSignalReturn: -0.00025, profitFactor: 0.877,
      reviewedPaperRuns: 17, profitablePaperRuns: 6, losingPaperRuns: 11,
      paperPortfolioReturn: -0.04, calculatedAt: "2026-08-29T13:00:00Z",
      strategyPerformance: {
        legacyProduction: metrics("legacy_production", "LEGACY PRODUCTION", "旧 scanner 实际历史邮件", "signals", 224, null, 224, 0, 82, 142, -0.0024, -0.55, 0.873, -0.53),
        v42Forward: metrics("v4_2_forward", "V4.2 FORWARD", "dynamic_relative_strength_breakout / STRONG_EXTENSION_10_15", "signals", 2, null, 0, 2, 0, 0, null, null, null, null),
        v4Forward: metrics("v4_forward", "V4 FORWARD", "dynamic_relative_strength_breakout / current V4 production forward", "signals", 5, null, 3, 2, 2, 1, 0.004, 0.012, 1.18, -0.041),
        v4Shadow: metrics("v4_shadow", "V4 SHADOW", "dynamic_relative_weakness_breakdown / SHADOW_ONLY", "signals", 3, null, 0, 3, 0, 0, null, null, null, null),
        v31ForwardPaper: metrics("v3_1_forward_paper", "V3.1 FORWARD PAPER", "v3_1_residual_momentum_beta_neutral", "periods", 12, 5, 4, 1, 2, 2, 0.004, 0.016, 1.21, -0.031),
        v33ForwardPaper: metrics("v3_3_forward_paper", "V3.3 FORWARD PAPER", "v3_3_vol_target_catastrophe_breaker", "periods", 16, 6, 5, 1, 2, 3, -0.003, -0.018, 0.91, -0.054),
        v34ForwardPaper: metrics("v3_4_forward_paper", "V3.4 FORWARD PAPER", "v3_4_unified_residual_volatility_risk", "periods", 24, 4, 3, 1, 1, 2, -0.018, -0.056, 0.48, -0.095),
        fundingCarryV2ForwardPaper: metrics("funding_carry_v2_forward_paper", "FUNDING CARRY V2 FORWARD PAPER", "funding_carry_perp_reversion_ema100_v2", "periods", 10, 10, 10, 0, 3, 7, 0.000034, 0.000344, 1.275, -0.000888)
      },
      forwardPromotionGate: { status: "INSUFFICIENT_FORWARD_SAMPLE", reviewedSignals: 0, minimumReviewedSignals: 30 }
    };
    renderPerformanceSummary(performanceFixture);

    const emptyV4ForwardFixture = {
      ...performanceFixture,
      strategyPerformance: {
        ...performanceFixture.strategyPerformance,
        v4Forward: metrics(
          "v4_forward", "V4 FORWARD", "dynamic_relative_strength_breakout / current V4 production forward",
          "signals", 0, null, 0, 0, 0, 0, null, null, null, null
        )
      }
    };
    renderPerformanceSummary(emptyV4ForwardFixture);
    const emptyV4ForwardLabels = [...document.querySelectorAll(".strategy-performance-title strong")]
      .map((item) => item.textContent.trim());
    if (emptyV4ForwardLabels.includes("V4 FORWARD")) {
      throw new Error("empty V4 FORWARD strategy card should be hidden");
    }

    const firstV4ForwardFixture = {
      ...emptyV4ForwardFixture,
      strategyPerformance: {
        ...emptyV4ForwardFixture.strategyPerformance,
        v4Forward: metrics(
          "v4_forward", "V4 FORWARD", "dynamic_relative_strength_breakout / current V4 production forward",
          "signals", 1, null, 0, 1, 0, 0, null, null, null, null
        )
      }
    };
    renderPerformanceSummary(firstV4ForwardFixture);
    const firstV4ForwardLabels = [...document.querySelectorAll(".strategy-performance-title strong")]
      .map((item) => item.textContent.trim());
    const expectedFirstV4ForwardLabels = [
      "V4.2 FORWARD",
      "V4 FORWARD",
      "V4 SHADOW",
      "FUNDING CARRY V2 FORWARD PAPER",
      "V3.4 FORWARD PAPER",
      "V3.3 FORWARD PAPER",
      "V3.1 FORWARD PAPER",
      "LEGACY PRODUCTION"
    ];
    if (JSON.stringify(firstV4ForwardLabels) !== JSON.stringify(expectedFirstV4ForwardLabels)) {
      throw new Error(`one-signal V4 FORWARD order mismatch: ${JSON.stringify(firstV4ForwardLabels)}`);
    }
    renderPerformanceSummary(performanceFixture);

    renderAlertsV2([
      {
        signal_key: "long", asset: "BTCUSDT", sent_at: "2026-08-29T09:15:00Z",
        strategy_id: "dynamic_relative_strength_breakout",
        model_version: "DYNAMIC_SPOT_V2_2026-08-01",
        payload: {
          signalVariant: "STRONG_EXTENSION_10_15",
          signalTier: "OBSERVATION", alertTierLabel: "STRONG EXTENSION / OBSERVATION", direction: "LONG",
          referencePrice: 112450, currentPrice: 111980, priceDriftPct: -0.0042,
          triggerReason: "极长原因 ".repeat(100), invalidCondition: "极长失效条件 ".repeat(100),
          review: { status: "pending", returnPct: -0.0031, reason: "监控中" }
        }
      },
      {
        signal_key: "core", asset: "ETHUSDT", sent_at: "2026-08-29T08:15:00Z",
        strategy_id: "dynamic_relative_strength_breakout",
        model_version: "DYNAMIC_SPOT_V2_2026-08-01",
        payload: {
          signalVariant: "STRONG_CORE_8_10", direction: "LONG", referencePrice: 4000, currentPrice: 4020,
          priceDriftPct: 0.005, review: { status: "pending" }
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
      },
      {
        signal_key: "funding", asset: "SOLUSDT", sent_at: "2026-08-27T09:15:00Z",
        model_version: "FUNDING CARRY PERP Z-SCORE V2 PAPER",
        payload: {
          direction: "LONG", referencePrice: 150, currentPrice: 151, priceDriftPct: 0.0067,
          review: { status: "pending" }
        }
      }
    ]);
  });

  const results = [];
  const performanceLabels = await page.locator(".strategy-performance-title strong").allTextContents();
  const expectedPerformanceLabels = [
    "V4.2 FORWARD",
    "V4 FORWARD",
    "V4 SHADOW",
    "FUNDING CARRY V2 FORWARD PAPER",
    "V3.4 FORWARD PAPER",
    "V3.3 FORWARD PAPER",
    "V3.1 FORWARD PAPER",
    "LEGACY PRODUCTION"
  ];
  if (JSON.stringify(performanceLabels) !== JSON.stringify(expectedPerformanceLabels)) {
    throw new Error(`strategy performance order mismatch: ${JSON.stringify(performanceLabels)}`);
  }
  for (const width of [1440, 1024, 920, 900, 841, 840, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator(".signal-item").evaluateAll((items) => items.forEach((item) => { item.open = false; }));
    const closed = await page.evaluate(() => {
      const feed = document.querySelector(".signal-feed");
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        feedOverflow: feed.scrollWidth > feed.clientWidth,
        detailsVisible: [...document.querySelectorAll(".signal-more")].every((item) => item.getBoundingClientRect().right <= document.documentElement.clientWidth),
        strategyLabels: [...document.querySelectorAll(".signal-strategy .signal-tag")].map((item) => item.textContent.trim()),
        strategyVisible: [...document.querySelectorAll(".signal-strategy .signal-tag")].every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
        }),
        timeVisible: [...document.querySelectorAll(".signal-time")].every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
        })
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
    const passed = !closed.documentOverflow
      && !closed.feedOverflow
      && closed.detailsVisible
      && closed.strategyVisible
      && closed.timeVisible
      && closed.strategyLabels[0] === "V4.2 FORWARD"
      && closed.strategyLabels[1] === "V4 FORWARD"
      && closed.strategyLabels[2] === "V3.4 FORWARD PAPER"
      && closed.strategyLabels[3] === "FUNDING CARRY V2 FORWARD PAPER"
      && !open.documentOverflow
      && !open.feedOverflow;
    if (!passed) throw new Error(`responsive overflow at ${width}px: ${JSON.stringify({ closed, open })}`);
    results.push({ width, closed, open, passed });
  }
  return results;
}
