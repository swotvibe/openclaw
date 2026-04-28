import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function importWithoutProcess(moduleHref: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `globalThis.process = undefined; await import(${JSON.stringify(moduleHref)});`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("auto-reply browser-safe imports", () => {
  it("imports heartbeat and tokens without process", () => {
    const heartbeatModuleHref = new URL("./heartbeat.ts", import.meta.url).href;
    const tokensModuleHref = new URL("./tokens.ts", import.meta.url).href;

    const tokensResult = importWithoutProcess(tokensModuleHref);
    expect(tokensResult.status).toBe(0);
    expect(tokensResult.stderr.trim()).toBe("");

    const heartbeatResult = importWithoutProcess(heartbeatModuleHref);
    expect(heartbeatResult.status).toBe(0);
    expect(heartbeatResult.stderr.trim()).toBe("");
  });
});
