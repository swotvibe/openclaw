import { execFileSync } from "node:child_process";
import os from "node:os";

const LOW_MEMORY_THRESHOLD_GIB = 12;

function shouldUseLowMemoryMode() {
  if (process.env.CI) {
    return false;
  }
  if (process.env.OPENCLAW_FORCE_FULL_LINT === "1") {
    return false;
  }
  if (process.env.OPENCLAW_LOW_MEMORY_CHECKS === "1") {
    return true;
  }
  return os.totalmem() < LOW_MEMORY_THRESHOLD_GIB * 1024 ** 3;
}

const args = ["./node_modules/.bin/oxlint"];

if (shouldUseLowMemoryMode()) {
  console.warn(
    `[run-oxlint] low-memory mode enabled; running oxlint without type-aware tsgolint (total RAM: ${Math.round(
      os.totalmem() / 1024 ** 3,
    )} GiB)`,
  );
  args.push("--threads=1");
} else {
  args.push("--type-aware");
}

args.push(...process.argv.slice(2));

execFileSync("node", args, {
  stdio: "inherit",
  env: process.env,
});
