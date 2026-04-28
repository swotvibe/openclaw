import { describe, expect, it } from "vitest";
import {
  SAAS_INITIAL_TENANT_DEK_VERSION,
  createSaasTenantDekAssociatedData,
  createSaasTenantDekMetadata,
} from "./tenant-deks.js";

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("SaaS tenant DEK helpers", () => {
  it("creates stable associated data for tenant DEK encryption", () => {
    expect(createSaasTenantDekAssociatedData(TENANT_ID, SAAS_INITIAL_TENANT_DEK_VERSION)).toBe(
      `openclaw_saas:tenant_dek:${TENANT_ID}:1`,
    );
  });

  it("normalizes tenant DEK metadata", () => {
    expect(createSaasTenantDekMetadata(" local:v1 ")).toEqual({
      version: 1,
      keyId: "local:v1",
      algorithm: "aes-256-gcm",
    });
  });
});
