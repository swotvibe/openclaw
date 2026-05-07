import { describe, expect, it } from "vitest";
import { SaasDekCache } from "./dek-cache.js";
import { SAAS_SECRET_DEK_LENGTH_BYTES } from "./envelope-encryption.js";
import { createLocalSaasKmsProvider, type SaasKmsProvider } from "./kms.js";
import type { SaasPostgresQueryExecutor } from "./postgres-migration-runner.js";
import { createSaasTenantDekAssociatedData } from "./tenant-deks.js";
import {
  SaasTenantSecretNotReadyError,
  SaasTenantSecretValidationError,
  readSaasTenantSecret,
  writeSaasTenantSecret,
} from "./tenant-secrets.js";

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const MASTER_KEY = `hex:${Buffer.alloc(32, 8).toString("hex")}`;

type QueryCall = {
  sql: string;
  params?: readonly unknown[];
};

type TenantDekRow = {
  tenant_id: string;
  version: number;
  encrypted_dek: Buffer;
  kek_id: string;
  algorithm: "aes-256-gcm";
  is_active: boolean;
};

type TenantSecretRow = {
  tenant_id: string;
  secret_ref: string;
  provider: string;
  key_id: string;
  ciphertext: Buffer;
  metadata_json: Record<string, unknown>;
  dek_version: number;
  algorithm: "aes-256-gcm";
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function createCountingKmsProvider(provider: SaasKmsProvider): SaasKmsProvider & {
  decryptCount: () => number;
} {
  let decrypts = 0;
  return {
    keyId: () => provider.keyId(),
    encrypt: (plaintext, associatedData) => provider.encrypt(plaintext, associatedData),
    async decrypt(encrypted, associatedData) {
      decrypts += 1;
      return await provider.decrypt(encrypted, associatedData);
    },
    decryptCount: () => decrypts,
  };
}

async function encryptedTenantDek(params: {
  tenantId: string;
  version?: number;
  dek: Buffer;
  kmsProvider: SaasKmsProvider;
}): Promise<TenantDekRow> {
  const version = params.version ?? 1;
  const encrypted = await params.kmsProvider.encrypt(
    params.dek,
    createSaasTenantDekAssociatedData(params.tenantId, version),
  );
  return {
    tenant_id: params.tenantId,
    version,
    encrypted_dek: encrypted.ciphertext,
    kek_id: encrypted.keyId,
    algorithm: encrypted.algorithm,
    is_active: true,
  };
}

function createExecutor(params: { tenantDeks?: TenantDekRow[] } = {}): SaasPostgresQueryExecutor & {
  calls: QueryCall[];
  tenantSecrets: TenantSecretRow[];
} {
  const calls: QueryCall[] = [];
  const tenantDeks = [...(params.tenantDeks ?? [])];
  const tenantSecrets: TenantSecretRow[] = [];
  let currentTenantId: string | undefined;

  return {
    calls,
    tenantSecrets,
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams?: readonly unknown[],
    ) {
      calls.push(queryParams ? { sql, params: queryParams } : { sql });
      const normalized = normalizeSql(sql);

      if (normalized.startsWith("select set_config")) {
        currentTenantId = String(queryParams?.[0]);
        return { rows: [] as readonly TRow[] };
      }

      if (
        normalized.startsWith("SELECT version, encrypted_dek, kek_id, algorithm") &&
        normalized.includes("is_active = true")
      ) {
        const tenantId = String(queryParams?.[0]);
        return {
          rows: tenantDeks
            .filter((row) => row.tenant_id === currentTenantId && row.tenant_id === tenantId)
            .filter((row) => row.is_active)
            .toSorted((left, right) => right.version - left.version)
            .slice(0, 1) as unknown as readonly TRow[],
        };
      }

      if (
        normalized.startsWith("SELECT version, encrypted_dek, kek_id, algorithm") &&
        normalized.includes("version = $2")
      ) {
        const tenantId = String(queryParams?.[0]);
        const version = Number(queryParams?.[1]);
        return {
          rows: tenantDeks.filter(
            (row) =>
              row.tenant_id === currentTenantId &&
              row.tenant_id === tenantId &&
              row.version === version,
          ) as unknown as readonly TRow[],
        };
      }

      if (normalized.startsWith("INSERT INTO openclaw_saas.tenant_secrets")) {
        const row: TenantSecretRow = {
          tenant_id: String(queryParams?.[0]),
          secret_ref: String(queryParams?.[1]),
          provider: String(queryParams?.[2]),
          key_id: String(queryParams?.[3]),
          ciphertext: Buffer.from(queryParams?.[4] as Buffer),
          metadata_json: JSON.parse(String(queryParams?.[5])) as Record<string, unknown>,
          dek_version: Number(queryParams?.[6]),
          algorithm: queryParams?.[7] as "aes-256-gcm",
        };
        const existingIndex = tenantSecrets.findIndex(
          (secret) => secret.tenant_id === row.tenant_id && secret.secret_ref === row.secret_ref,
        );
        if (existingIndex >= 0) {
          tenantSecrets[existingIndex] = row;
        } else {
          tenantSecrets.push(row);
        }
        return {
          rows: [
            {
              tenant_id: row.tenant_id,
              secret_ref: row.secret_ref,
              provider: row.provider,
              key_id: row.key_id,
              metadata_json: row.metadata_json,
              dek_version: row.dek_version,
              algorithm: row.algorithm,
            },
          ] as unknown as readonly TRow[],
        };
      }

      if (normalized.startsWith("SELECT tenant_id::text AS tenant_id")) {
        const tenantId = String(queryParams?.[0]);
        const secretRef = String(queryParams?.[1]);
        return {
          rows: tenantSecrets.filter(
            (row) =>
              row.tenant_id === currentTenantId &&
              row.tenant_id === tenantId &&
              row.secret_ref === secretRef,
          ) as unknown as readonly TRow[],
        };
      }

      return { rows: [] as readonly TRow[] };
    },
  };
}

describe("SaaS tenant secrets", () => {
  it("writes encrypted tenant secrets without returning plaintext", async () => {
    const kmsProvider = createLocalSaasKmsProvider({ masterKey: MASTER_KEY, keyId: "local:test" });
    const tenantDek = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 9);
    const executor = createExecutor({
      tenantDeks: [
        await encryptedTenantDek({
          tenantId: TENANT_ID,
          dek: tenantDek,
          kmsProvider,
        }),
      ],
    });

    const result = await writeSaasTenantSecret(
      executor,
      {
        tenantId: TENANT_ID,
        secretRef: "openai/api-key",
        provider: "OpenAI",
        keyId: "OPENAI_API_KEY",
        plaintext: "sk-test-secret",
        metadata: { source: "test" },
      },
      { kmsProvider },
    );

    expect(result).toEqual({
      tenantId: TENANT_ID,
      secretRef: "openai/api-key",
      provider: "openai",
      keyId: "OPENAI_API_KEY",
      dekVersion: 1,
      algorithm: "aes-256-gcm",
      metadata: { source: "test" },
      written: true,
    });
    expect("plaintext" in result).toBe(false);
    expect(executor.tenantSecrets).toHaveLength(1);
    expect(executor.tenantSecrets[0]?.ciphertext.toString("utf8")).not.toContain("sk-test-secret");
    expect(executor.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("SELECT version, encrypted_dek, kek_id, algorithm"),
      expect.stringContaining("INSERT INTO openclaw_saas.tenant_secrets"),
      "COMMIT",
    ]);
  });

  it("reads and decrypts tenant secrets using the DEK cache", async () => {
    const kmsProvider = createCountingKmsProvider(
      createLocalSaasKmsProvider({ masterKey: MASTER_KEY, keyId: "local:test" }),
    );
    const tenantDek = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 9);
    const dekCache = new SaasDekCache();
    const executor = createExecutor({
      tenantDeks: [
        await encryptedTenantDek({
          tenantId: TENANT_ID,
          dek: tenantDek,
          kmsProvider,
        }),
      ],
    });

    await writeSaasTenantSecret(
      executor,
      {
        tenantId: TENANT_ID,
        secretRef: "openai/api-key",
        provider: "openai",
        keyId: "OPENAI_API_KEY",
        plaintext: "sk-test-secret",
      },
      { kmsProvider, dekCache },
    );
    const result = await readSaasTenantSecret(
      executor,
      {
        tenantId: TENANT_ID,
        secretRef: "openai/api-key",
      },
      { kmsProvider, dekCache },
    );

    expect(result?.plaintext.toString("utf8")).toBe("sk-test-secret");
    expect(kmsProvider.decryptCount()).toBe(1);
  });

  it("returns null when another tenant context cannot see the secret", async () => {
    const kmsProvider = createLocalSaasKmsProvider({ masterKey: MASTER_KEY, keyId: "local:test" });
    const tenantDek = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 9);
    const executor = createExecutor({
      tenantDeks: [
        await encryptedTenantDek({
          tenantId: TENANT_ID,
          dek: tenantDek,
          kmsProvider,
        }),
      ],
    });

    await writeSaasTenantSecret(
      executor,
      {
        tenantId: TENANT_ID,
        secretRef: "openai/api-key",
        provider: "openai",
        keyId: "OPENAI_API_KEY",
        plaintext: "sk-test-secret",
      },
      { kmsProvider },
    );

    await expect(
      readSaasTenantSecret(
        executor,
        {
          tenantId: OTHER_TENANT_ID,
          secretRef: "openai/api-key",
        },
        { kmsProvider },
      ),
    ).resolves.toBeNull();
  });

  it("rolls back when a tenant has no active DEK", async () => {
    const kmsProvider = createLocalSaasKmsProvider({ masterKey: MASTER_KEY, keyId: "local:test" });
    const executor = createExecutor();

    await expect(
      writeSaasTenantSecret(
        executor,
        {
          tenantId: TENANT_ID,
          secretRef: "openai/api-key",
          provider: "openai",
          keyId: "OPENAI_API_KEY",
          plaintext: "sk-test-secret",
        },
        { kmsProvider },
      ),
    ).rejects.toThrow(SaasTenantSecretNotReadyError);

    expect(executor.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects invalid secret refs before opening a transaction", async () => {
    const kmsProvider = createLocalSaasKmsProvider({ masterKey: MASTER_KEY, keyId: "local:test" });
    const executor = createExecutor();

    await expect(
      writeSaasTenantSecret(
        executor,
        {
          tenantId: TENANT_ID,
          secretRef: "../bad ref",
          provider: "openai",
          keyId: "OPENAI_API_KEY",
          plaintext: "sk-test-secret",
        },
        { kmsProvider },
      ),
    ).rejects.toThrow(SaasTenantSecretValidationError);

    expect(executor.calls).toEqual([]);
  });
});
