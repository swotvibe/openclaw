import { SaasDekCache } from "./dek-cache.js";
import {
  SAAS_SECRET_ENCRYPTION_ALGORITHM,
  assertSaasAes256GcmKey,
  decryptSaasSecretValue,
  encryptSaasSecretValue,
  packSaasEncryptedSecretPayload,
  unpackSaasEncryptedSecretPayload,
  type SaasSecretBytes,
} from "./envelope-encryption.js";
import type { SaasKmsProvider } from "./kms.js";
import type { SaasPostgresQueryExecutor } from "./postgres-migration-runner.js";
import {
  createPostgresSetTenantContextQuery,
  parseTenantId,
  type TenantId,
} from "./tenant-context.js";
import { createSaasTenantDekAssociatedData } from "./tenant-deks.js";

export type SaasTenantSecretMetadata = Record<string, unknown>;

export type SaasTenantSecretWriteInput = {
  tenantId: string;
  secretRef: string;
  provider: string;
  keyId: string;
  plaintext: SaasSecretBytes;
  metadata?: SaasTenantSecretMetadata;
};

export type SaasTenantSecretReadInput = {
  tenantId: string;
  secretRef: string;
};

export type SaasTenantSecretRecord = {
  tenantId: TenantId;
  secretRef: string;
  provider: string;
  keyId: string;
  dekVersion: number;
  algorithm: typeof SAAS_SECRET_ENCRYPTION_ALGORITHM;
  metadata: SaasTenantSecretMetadata;
};

export type SaasTenantSecretWriteResult = SaasTenantSecretRecord & {
  written: true;
};

export type SaasTenantSecretReadResult = SaasTenantSecretRecord & {
  plaintext: Buffer;
};

export type SaasTenantSecretRepositoryOptions = {
  kmsProvider: SaasKmsProvider;
  dekCache?: SaasDekCache;
};

type TenantDekRow = {
  version: unknown;
  encrypted_dek: unknown;
  kek_id: unknown;
  algorithm: unknown;
};

type TenantSecretRow = {
  tenant_id: unknown;
  secret_ref: unknown;
  provider: unknown;
  key_id: unknown;
  ciphertext?: unknown;
  metadata_json: unknown;
  dek_version: unknown;
  algorithm: unknown;
};

type NormalizedSecretInput = {
  tenantId: TenantId;
  secretRef: string;
  provider: string;
  keyId: string;
  metadata: SaasTenantSecretMetadata;
};

type ResolvedTenantDek = {
  version: number;
  dek: Buffer;
};

export class SaasTenantSecretValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "SaasTenantSecretValidationError";
  }
}

export class SaasTenantSecretEncryptionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaasTenantSecretEncryptionError";
  }
}

export class SaasTenantSecretNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasTenantSecretNotReadyError";
  }
}

const SECRET_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function toSecretBuffer(value: SaasSecretBytes): Buffer {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
}

function normalizeTextField(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new SaasTenantSecretValidationError(`${field} is required.`, field);
  }
  if (normalized.length > maxLength) {
    throw new SaasTenantSecretValidationError(
      `${field} must be at most ${maxLength} characters.`,
      field,
    );
  }
  return normalized;
}

export function normalizeSaasTenantSecretRef(value: string): string {
  const secretRef = normalizeTextField(value, "secretRef", 256);
  if (!SECRET_REF_PATTERN.test(secretRef)) {
    throw new SaasTenantSecretValidationError(
      "secretRef must start with a letter or number and contain only letters, numbers, dots, underscores, colons, slashes, or hyphens.",
      "secretRef",
    );
  }
  return secretRef;
}

function normalizeProvider(value: string): string {
  const provider = normalizeTextField(value, "provider", 64).toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new SaasTenantSecretValidationError(
      "provider must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens.",
      "provider",
    );
  }
  return provider;
}

function normalizeMetadata(
  metadata: SaasTenantSecretMetadata | undefined,
): SaasTenantSecretMetadata {
  if (metadata === undefined) {
    return {};
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Buffer.isBuffer(metadata)
  ) {
    throw new SaasTenantSecretValidationError("metadata must be a JSON object.", "metadata");
  }
  try {
    JSON.stringify(metadata);
  } catch (error) {
    throw new SaasTenantSecretValidationError(
      `metadata must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
      "metadata",
    );
  }
  return { ...metadata };
}

function normalizeWriteInput(input: SaasTenantSecretWriteInput): NormalizedSecretInput {
  return {
    tenantId: parseTenantId(input.tenantId),
    secretRef: normalizeSaasTenantSecretRef(input.secretRef),
    provider: normalizeProvider(input.provider),
    keyId: normalizeTextField(input.keyId, "keyId", 256),
    metadata: normalizeMetadata(input.metadata),
  };
}

function normalizeReadInput(
  input: SaasTenantSecretReadInput,
): Pick<NormalizedSecretInput, "tenantId" | "secretRef"> {
  return {
    tenantId: parseTenantId(input.tenantId),
    secretRef: normalizeSaasTenantSecretRef(input.secretRef),
  };
}

function createSaasTenantSecretAssociatedData(record: {
  tenantId: TenantId;
  secretRef: string;
  provider: string;
  keyId: string;
  dekVersion: number;
}): string {
  return [
    "openclaw_saas",
    "tenant_secret",
    record.tenantId,
    record.secretRef,
    record.provider,
    record.keyId,
    String(record.dekVersion),
  ].join(":");
}

function normalizeTenantDekRow(row: TenantDekRow | undefined): {
  version: number;
  encryptedDek: Buffer;
  keyId: string;
  algorithm: typeof SAAS_SECRET_ENCRYPTION_ALGORITHM;
} {
  if (!row) {
    throw new SaasTenantSecretNotReadyError("No active SaaS tenant DEK exists for this tenant.");
  }
  if (
    typeof row.version !== "number" ||
    !Number.isInteger(row.version) ||
    row.version <= 0 ||
    !Buffer.isBuffer(row.encrypted_dek) ||
    typeof row.kek_id !== "string" ||
    row.algorithm !== SAAS_SECRET_ENCRYPTION_ALGORITHM
  ) {
    throw new SaasTenantSecretEncryptionError("Invalid SaaS tenant DEK row.");
  }
  return {
    version: row.version,
    encryptedDek: row.encrypted_dek,
    keyId: row.kek_id,
    algorithm: row.algorithm,
  };
}

function normalizeSecretMetadata(value: unknown): SaasTenantSecretMetadata {
  if (value && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function normalizeTenantSecretRecord(row: TenantSecretRow): SaasTenantSecretRecord {
  if (
    typeof row.tenant_id !== "string" ||
    typeof row.secret_ref !== "string" ||
    typeof row.provider !== "string" ||
    typeof row.key_id !== "string" ||
    typeof row.dek_version !== "number" ||
    !Number.isInteger(row.dek_version) ||
    row.dek_version <= 0 ||
    row.algorithm !== SAAS_SECRET_ENCRYPTION_ALGORITHM
  ) {
    throw new SaasTenantSecretEncryptionError("Invalid SaaS tenant secret row.");
  }
  return {
    tenantId: parseTenantId(row.tenant_id),
    secretRef: row.secret_ref,
    provider: row.provider,
    keyId: row.key_id,
    dekVersion: row.dek_version,
    algorithm: row.algorithm,
    metadata: normalizeSecretMetadata(row.metadata_json),
  };
}

async function rollbackBestEffort(executor: SaasPostgresQueryExecutor): Promise<void> {
  try {
    await executor.query("ROLLBACK");
  } catch {
    // Preserve the original secret operation failure.
  }
}

async function setTenantContext(
  executor: SaasPostgresQueryExecutor,
  tenantId: TenantId,
): Promise<void> {
  const tenantContext = createPostgresSetTenantContextQuery(tenantId);
  await executor.query(tenantContext.text, tenantContext.values);
}

async function loadTenantDek(
  executor: SaasPostgresQueryExecutor,
  tenantId: TenantId,
  options: SaasTenantSecretRepositoryOptions,
  params: { active: true } | { version: number },
): Promise<ResolvedTenantDek> {
  const cachedVersion = "version" in params ? params.version : undefined;
  if (cachedVersion !== undefined) {
    const cached = options.dekCache?.get(tenantId, cachedVersion);
    if (cached) {
      return { version: cachedVersion, dek: cached };
    }
  }

  const result =
    "active" in params
      ? await executor.query<TenantDekRow>(
          `
SELECT version, encrypted_dek, kek_id, algorithm
FROM openclaw_saas.tenant_deks
WHERE tenant_id = $1
  AND is_active = true
ORDER BY version DESC
LIMIT 1
`.trim(),
          [tenantId],
        )
      : await executor.query<TenantDekRow>(
          `
SELECT version, encrypted_dek, kek_id, algorithm
FROM openclaw_saas.tenant_deks
WHERE tenant_id = $1
  AND version = $2
LIMIT 1
`.trim(),
          [tenantId, params.version],
        );

  const row = normalizeTenantDekRow(result.rows[0]);
  const dek = await options.kmsProvider.decrypt(
    {
      keyId: row.keyId,
      algorithm: row.algorithm,
      ciphertext: row.encryptedDek,
    },
    createSaasTenantDekAssociatedData(tenantId, row.version),
  );
  assertSaasAes256GcmKey(dek);
  options.dekCache?.set(tenantId, row.version, dek);
  return {
    version: row.version,
    dek,
  };
}

export async function writeSaasTenantSecret(
  executor: SaasPostgresQueryExecutor,
  input: SaasTenantSecretWriteInput,
  options: SaasTenantSecretRepositoryOptions,
): Promise<SaasTenantSecretWriteResult> {
  const normalized = normalizeWriteInput(input);
  const plaintext = toSecretBuffer(input.plaintext);
  let dek: Buffer | undefined;
  await executor.query("BEGIN");

  try {
    await setTenantContext(executor, normalized.tenantId);
    const resolvedDek = await loadTenantDek(executor, normalized.tenantId, options, {
      active: true,
    });
    dek = resolvedDek.dek;
    const encrypted = encryptSaasSecretValue(
      plaintext,
      dek,
      resolvedDek.version,
      createSaasTenantSecretAssociatedData({
        ...normalized,
        dekVersion: resolvedDek.version,
      }),
    );
    const ciphertext = packSaasEncryptedSecretPayload(encrypted);
    const result = await executor.query<TenantSecretRow>(
      `
INSERT INTO openclaw_saas.tenant_secrets (
  tenant_id,
  secret_ref,
  provider,
  key_id,
  ciphertext,
  metadata_json,
  dek_version,
  algorithm,
  updated_at
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
ON CONFLICT (tenant_id, secret_ref) DO UPDATE
SET provider = EXCLUDED.provider,
    key_id = EXCLUDED.key_id,
    ciphertext = EXCLUDED.ciphertext,
    metadata_json = EXCLUDED.metadata_json,
    dek_version = EXCLUDED.dek_version,
    algorithm = EXCLUDED.algorithm,
    updated_at = now()
RETURNING tenant_id::text AS tenant_id,
          secret_ref,
          provider,
          key_id,
          metadata_json,
          dek_version,
          algorithm
`.trim(),
      [
        normalized.tenantId,
        normalized.secretRef,
        normalized.provider,
        normalized.keyId,
        ciphertext,
        JSON.stringify(normalized.metadata),
        resolvedDek.version,
        encrypted.algorithm,
      ],
    );
    await executor.query("COMMIT");
    const record = normalizeTenantSecretRecord(result.rows[0] as TenantSecretRow);
    return {
      ...record,
      written: true,
    };
  } catch (error) {
    await rollbackBestEffort(executor);
    if (
      error instanceof SaasTenantSecretValidationError ||
      error instanceof SaasTenantSecretEncryptionError ||
      error instanceof SaasTenantSecretNotReadyError
    ) {
      throw error;
    }
    throw new SaasTenantSecretEncryptionError("Failed to write SaaS tenant secret.", error);
  } finally {
    plaintext.fill(0);
    dek?.fill(0);
  }
}

export async function readSaasTenantSecret(
  executor: SaasPostgresQueryExecutor,
  input: SaasTenantSecretReadInput,
  options: SaasTenantSecretRepositoryOptions,
): Promise<SaasTenantSecretReadResult | null> {
  const normalized = normalizeReadInput(input);
  let dek: Buffer | undefined;
  await executor.query("BEGIN");

  try {
    await setTenantContext(executor, normalized.tenantId);
    const result = await executor.query<TenantSecretRow>(
      `
SELECT tenant_id::text AS tenant_id,
       secret_ref,
       provider,
       key_id,
       ciphertext,
       metadata_json,
       dek_version,
       algorithm
FROM openclaw_saas.tenant_secrets
WHERE tenant_id = $1
  AND secret_ref = $2
LIMIT 1
`.trim(),
      [normalized.tenantId, normalized.secretRef],
    );

    const row = result.rows[0];
    if (!row) {
      await executor.query("COMMIT");
      return null;
    }
    if (!Buffer.isBuffer(row.ciphertext)) {
      throw new SaasTenantSecretEncryptionError("Invalid SaaS tenant secret ciphertext.");
    }

    const record = normalizeTenantSecretRecord(row);
    const resolvedDek = await loadTenantDek(executor, normalized.tenantId, options, {
      version: record.dekVersion,
    });
    dek = resolvedDek.dek;
    const payload = unpackSaasEncryptedSecretPayload(row.ciphertext, record.dekVersion);
    const plaintext = decryptSaasSecretValue(
      payload,
      dek,
      createSaasTenantSecretAssociatedData(record),
    );
    await executor.query("COMMIT");
    return {
      ...record,
      plaintext,
    };
  } catch (error) {
    await rollbackBestEffort(executor);
    if (
      error instanceof SaasTenantSecretValidationError ||
      error instanceof SaasTenantSecretEncryptionError ||
      error instanceof SaasTenantSecretNotReadyError
    ) {
      throw error;
    }
    throw new SaasTenantSecretEncryptionError("Failed to read SaaS tenant secret.", error);
  } finally {
    dek?.fill(0);
  }
}
