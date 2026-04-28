import { describe, expect, it } from "vitest";
import { SaasDekCache, SaasDekCacheConfigurationError } from "./dek-cache.js";
import { SAAS_SECRET_DEK_LENGTH_BYTES } from "./envelope-encryption.js";

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";

describe("SaasDekCache", () => {
  it("stores defensive copies and expires entries by TTL", () => {
    let now = 1_000;
    const cache = new SaasDekCache({ ttlMs: 100, now: () => now });
    const dek = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 1);

    cache.set(TENANT_ID, 1, dek);
    dek.fill(2);

    const first = cache.get(TENANT_ID, 1);
    expect(first).toEqual(Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 1));
    first?.fill(3);
    expect(cache.get(TENANT_ID, 1)).toEqual(Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 1));

    now = 1_100;
    expect(cache.get(TENANT_ID, 1)).toBeNull();
  });

  it("invalidates one tenant without clearing other tenants", () => {
    const cache = new SaasDekCache();
    const dek = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 1);

    cache.set(TENANT_ID, 1, dek);
    cache.set(OTHER_TENANT_ID, 1, dek);
    cache.invalidateTenant(TENANT_ID);

    expect(cache.get(TENANT_ID, 1)).toBeNull();
    expect(cache.get(OTHER_TENANT_ID, 1)).toEqual(dek);
  });

  it("sweeps expired entries and rejects invalid inputs", () => {
    let now = 0;
    const cache = new SaasDekCache({ ttlMs: 10, now: () => now });
    cache.set(TENANT_ID, 1, Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 1));

    now = 10;
    cache.sweep();

    expect(cache.get(TENANT_ID, 1)).toBeNull();
    expect(() => new SaasDekCache({ ttlMs: 0 })).toThrow(SaasDekCacheConfigurationError);
    expect(() => cache.set(TENANT_ID, 1, Buffer.alloc(31))).toThrow();
  });
});
