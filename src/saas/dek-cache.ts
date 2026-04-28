import { assertSaasAes256GcmKey } from "./envelope-encryption.js";
import { parseTenantId, type TenantId } from "./tenant-context.js";

export type SaasDekCacheOptions = {
  ttlMs?: number;
  now?: () => number;
};

type SaasDekCacheEntry = {
  dek: Buffer;
  expiresAt: number;
};

export class SaasDekCacheConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasDekCacheConfigurationError";
  }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function assertDekVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new SaasDekCacheConfigurationError("SaaS DEK cache version must be a positive integer.");
  }
}

function cacheKey(tenantId: string | TenantId, version: number): string {
  assertDekVersion(version);
  return `${parseTenantId(tenantId)}:${version}`;
}

export class SaasDekCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, SaasDekCacheEntry>();

  constructor(options: SaasDekCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new SaasDekCacheConfigurationError("SaaS DEK cache ttlMs must be positive.");
    }
    this.now = options.now ?? Date.now;
  }

  get(tenantId: string | TenantId, version: number): Buffer | null {
    const key = cacheKey(tenantId, version);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return Buffer.from(entry.dek);
  }

  set(tenantId: string | TenantId, version: number, dek: Buffer): void {
    assertSaasAes256GcmKey(dek);
    const key = cacheKey(tenantId, version);
    this.entries.set(key, {
      dek: Buffer.from(dek),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  invalidateTenant(tenantId: string | TenantId): void {
    const prefix = `${parseTenantId(tenantId)}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }
}
