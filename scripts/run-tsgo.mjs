import { execFileSync } from "node:child_process";
import os from "node:os";

const LOW_MEMORY_THRESHOLD_GIB = 12;

function shouldUseLowMemoryMode() {
  if (process.env.CI) {
    return false;
  }
  if (process.env.OPENCLAW_FORCE_FULL_TYPECHECK === "1") {
    return false;
  }
  if (process.env.OPENCLAW_LOW_MEMORY_CHECKS === "1") {
    return true;
  }
  return os.totalmem() < LOW_MEMORY_THRESHOLD_GIB * 1024 ** 3;
}

function buildEnv(extraNodeOptions) {
  const env = { ...process.env };
  if (!extraNodeOptions) {
    return env;
  }
  env.NODE_OPTIONS = env.NODE_OPTIONS
    ? `${env.NODE_OPTIONS} ${extraNodeOptions}`.trim()
    : extraNodeOptions;
  return env;
}

function run(command, args, extraNodeOptions) {
  execFileSync(command, args, {
    stdio: "inherit",
    env: buildEnv(extraNodeOptions),
  });
}

const extraArgs = process.argv.slice(2);

if (shouldUseLowMemoryMode()) {
  console.warn(
    `[run-tsgo] low-memory mode enabled; using tsc --noEmit instead of tsgo (total RAM: ${Math.round(
      os.totalmem() / 1024 ** 3,
    )} GiB)`,
  );
  run("node", ["./node_modules/.bin/tsc", "--noEmit", ...extraArgs], "--max-old-space-size=4096");
} else {
  run("node", ["./node_modules/.bin/tsgo", "--noEmit", ...extraArgs]);
}
