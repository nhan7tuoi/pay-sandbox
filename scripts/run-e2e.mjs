#!/usr/bin/env node
/**
 * Runs the end-to-end suites against a freshly started sandbox:
 *   1. starts `node dist/cli.js` (run `npm run build` first),
 *   2. waits for /__sandbox/health,
 *   3. runs test-client.ts (Stripe) and test-gateways.ts (MoMo / ZaloPay / VNPay),
 *      resetting the sandbox in between so pending retries can't leak across suites,
 *   4. stops the sandbox and exits non-zero if any suite failed.
 *
 * Both suites start a webhook receiver on port 3000, so they run one after the other.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = process.env.PAY_SANDBOX_PORT ?? "4242";
const sandboxUrl = `http://localhost:${port}`;
const suites = ["test-client.ts", "test-gateways.ts"];

if (!existsSync(new URL("../dist/cli.js", import.meta.url))) {
  console.error("dist/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}

const sandbox = spawn(process.execPath, ["dist/cli.js", "--quiet", "--port", port], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
let sandboxExited = false;
sandbox.on("exit", () => {
  sandboxExited = true;
});

async function waitForSandbox(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sandboxExited) throw new Error("pay-sandbox exited before it became ready");
    try {
      const response = await fetch(`${sandboxUrl}/__sandbox/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error(`pay-sandbox did not become ready within ${timeoutMs}ms`);
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PAY_SANDBOX_PORT: port },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let failed = 0;
try {
  await waitForSandbox();
  for (const suite of suites) {
    await fetch(`${sandboxUrl}/__sandbox/reset`, { method: "POST" });
    console.log(`\n▶ ${suite}`);
    const code = await runSuite(suite);
    if (code !== 0) failed += 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed += 1;
} finally {
  sandbox.kill("SIGTERM");
}

console.log(failed === 0 ? "\nAll end-to-end suites passed." : `\n${failed} suite(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
