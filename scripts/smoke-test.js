import { renderTestEmail } from "../lib/report.js";
import { STRATEGIES } from "../lib/strategies.js";

if (!STRATEGIES.length) {
  throw new Error("No strategies registered");
}

const email = renderTestEmail();
if (!email.includes("云端信号系统测试邮件")) {
  throw new Error("Test email renderer failed");
}

console.log("Smoke test passed");
