import { describe, expect, it } from "vitest";
import { getSaasLocalStateStore, listSaasLocalStateStores } from "./local-state.js";

describe("SaaS local state inventory", () => {
  it("classifies known local stores before they are exposed to tenant APIs", () => {
    expect(listSaasLocalStateStores()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task-registry",
          classification: "operator-only-until-modeled",
        }),
        expect.objectContaining({
          id: "memory-store",
          classification: "tenant-owned-before-exposure",
        }),
        expect.objectContaining({
          id: "auth-profiles",
          classification: "tenant-owned-before-exposure",
        }),
      ]),
    );
  });

  it("returns stable lookup entries by id", () => {
    expect(getSaasLocalStateStore("exec-secret-providers")).toMatchObject({
      classification: "self-hosted-only",
    });
  });
});
