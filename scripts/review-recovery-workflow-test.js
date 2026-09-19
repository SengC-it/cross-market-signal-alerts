import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../.github/workflows/signal-cron.yml", import.meta.url), "utf8");
const signalStart = source.indexOf("  dynamic-spot-scan:");
const reviewStart = source.indexOf("  review-recovery:");
assert.ok(signalStart >= 0, "signal scanner job remains present");
assert.ok(reviewStart > signalStart, "review recovery job follows the signal scanner job");

const signalSection = source.slice(signalStart, reviewStart);
const reviewSection = source.slice(reviewStart);

assert.match(source, /workflow_dispatch:/);
assert.match(source, /cron:\s*["']30 19 \* \* \*["']/);
assert.match(source, /job:\s*\n\s+description:/);
assert.match(source, /options:\s*\n\s+- review\s*\n\s+- signal/);

assert.match(signalSection, /if:\s+github\.event_name == 'workflow_dispatch'/);
assert.match(signalSection, /groups=dynamic-spot,dynamic-weak-spot/);
assert.doesNotMatch(signalSection, /group=review/);

assert.match(reviewSection, /if:\s+github\.event_name == 'schedule'/);
assert.match(reviewSection, /--data-urlencode "group=review"/);
assert.doesNotMatch(reviewSection, /groups=dynamic-spot,dynamic-weak-spot/);

assert.match(source, /APP_URL="\$\{APP_URL%\/\}"/);
assert.match(source, /APP_URL="https:\/\/cross-market-signal-alerts\.vercel\.app"/);
assert.match(source, /secrets\.CRON_SECRET/);
assert.doesNotMatch(source, /\b(?:echo|printf)\b[^\n]*(?:CRON_SECRET|APP_URL)/);
assert.doesNotMatch(source, /--apply/);

console.log("review-recovery-workflow-test: all assertions passed");
