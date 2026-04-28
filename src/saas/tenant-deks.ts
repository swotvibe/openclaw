import {
  SAAS_SECRET_ENCRYPTION_ALGORITHM,
  type SaasEncryptedSecretPayload,
} from "./envelope-encryption.js";
import { parseTenantId, type TenantId } from "./tenant-context.js";

export const SAAS_INITIAL_TENANT_DEK_VERSION = 1;

export type SaasTenantDekMetadata = {
  version: number;
  keyId: string;
  algorithm: typeof SAAS_SECRET_ENCRYPTION_ALGORITHM;
};

export type EncryptedSaasTenantDek = SaasTenantDekMetadata & {
  encryptedDek: Buffer;
};

export type PackedSaasTenantDekPayload = Pick<SaasEncryptedSecretPayload, "algorithm"> & {
  keyId: string;
  ciphertext: Buffer;
};

function assertSaasTenantDekVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error("SaaS tenant DEK version must be a positive integer.");
  }
}

export function createSaasTenantDekAssociatedData(
  tenantId: string | TenantId,
  version: number,
): string {
  const normalizedTenantId = parseTenantId(tenantId);
  assertSaasTenantDekVersion(version);
  return `openclaw_saas:tenant_dek:${normalizedTenantId}:${version}`;
}

export function createSaasTenantDekMetadata(
  keyId: string,
  version: number = SAAS_INITIAL_TENANT_DEK_VERSION,
): SaasTenantDekMetadata {
  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId) {
    throw new Error("SaaS tenant DEK key id is required.");
  }
  assertSaasTenantDekVersion(version);
  return {
    version,
    keyId: normalizedKeyId,
    algorithm: SAAS_SECRET_ENCRYPTION_ALGORITHM,
  };
}
