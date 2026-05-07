import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { AppliedSaasPostgresMigration } from "./postgres-migration-plan.js";
import {
  loadAppliedSaasPostgresMigrations,
  loadAppliedSaasPostgresMigrationsReadOnly,
  runSaasPostgresMigrations,
  type RunSaasPostgresMigrationsResult,
  type SaasPostgresQueryExecutor,
} from "./postgres-migration-runner.js";
import { runSaasRlsIsolationSmoke, type SaasRlsIsolationSmokeResult } from "./rls-smoke.js";
import {
  provisionSaasTenant,
  type SaasTenantProvisioningInput,
  type SaasTenantProvisioningOptions,
  type SaasTenantProvisioningResult,
} from "./tenant-provisioning.js";
import {
  readSaasTenantSecret,
  writeSaasTenantSecret,
  type SaasTenantSecretReadInput,
  type SaasTenantSecretReadResult,
  type SaasTenantSecretRepositoryOptions,
  type SaasTenantSecretWriteInput,
  type SaasTenantSecretWriteResult,
} from "./tenant-secrets.js";

export type SaasPostgresPoolOptions = {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
  idleInTransactionSessionTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
  applicationName?: string;
};

const DEFAULT_APPLICATION_NAME = "openclaw-saas";
const DEFAULT_POOL_MAX = 5;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function createSaasPostgresPool(
  connectionString: string,
  options: SaasPostgresPoolOptions = {},
): Pool {
  const config: PoolConfig = {
    connectionString,
    max: options.max ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    statement_timeout: options.statementTimeoutMillis ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    lock_timeout: options.lockTimeoutMillis ?? DEFAULT_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      options.idleInTransactionSessionTimeoutMillis ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: options.applicationName ?? DEFAULT_APPLICATION_NAME,
    ...(options.allowExitOnIdle != null ? { allowExitOnIdle: options.allowExitOnIdle } : {}),
  };
  return new Pool(config);
}

export function createSaasPostgresPgExecutor(client: PoolClient): SaasPostgresQueryExecutor {
  return {
    async query(sql, params) {
      const result = await client.query(sql, params ? [...params] : undefined);
      return {
        rows: result.rows,
      };
    },
  };
}

export async function withSaasPostgresPgClient<TResult>(
  pool: Pool,
  callback: (executor: SaasPostgresQueryExecutor, client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  try {
    return await callback(createSaasPostgresPgExecutor(client), client);
  } finally {
    client.release();
  }
}

export async function loadAppliedSaasPostgresMigrationsWithPg(
  connectionString: string,
  options: SaasPostgresPoolOptions = {},
): Promise<readonly AppliedSaasPostgresMigration[]> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) =>
      loadAppliedSaasPostgresMigrations(executor),
    );
  } finally {
    await pool.end();
  }
}

export async function loadAppliedSaasPostgresMigrationsReadOnlyWithPg(
  connectionString: string,
  options: SaasPostgresPoolOptions = {},
): Promise<readonly AppliedSaasPostgresMigration[]> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) =>
      loadAppliedSaasPostgresMigrationsReadOnly(executor),
    );
  } finally {
    await pool.end();
  }
}

export async function runSaasPostgresMigrationsWithPg(
  connectionString: string,
  options: SaasPostgresPoolOptions = {},
): Promise<RunSaasPostgresMigrationsResult> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) => runSaasPostgresMigrations(executor));
  } finally {
    await pool.end();
  }
}

export async function provisionSaasTenantWithPg(
  connectionString: string,
  input: SaasTenantProvisioningInput,
  provisioningOptions: SaasTenantProvisioningOptions = {},
  options: SaasPostgresPoolOptions = {},
): Promise<SaasTenantProvisioningResult> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) =>
      provisionSaasTenant(executor, input, provisioningOptions),
    );
  } finally {
    await pool.end();
  }
}

export async function runSaasRlsIsolationSmokeWithPg(
  connectionString: string,
  options: SaasPostgresPoolOptions = {},
): Promise<SaasRlsIsolationSmokeResult> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) => runSaasRlsIsolationSmoke(executor));
  } finally {
    await pool.end();
  }
}

export async function writeSaasTenantSecretWithPg(
  connectionString: string,
  input: SaasTenantSecretWriteInput,
  repositoryOptions: SaasTenantSecretRepositoryOptions,
  options: SaasPostgresPoolOptions = {},
): Promise<SaasTenantSecretWriteResult> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) =>
      writeSaasTenantSecret(executor, input, repositoryOptions),
    );
  } finally {
    await pool.end();
  }
}

export async function readSaasTenantSecretWithPg(
  connectionString: string,
  input: SaasTenantSecretReadInput,
  repositoryOptions: SaasTenantSecretRepositoryOptions,
  options: SaasPostgresPoolOptions = {},
): Promise<SaasTenantSecretReadResult | null> {
  const pool = createSaasPostgresPool(connectionString, { ...options, allowExitOnIdle: true });
  try {
    return await withSaasPostgresPgClient(pool, (executor) =>
      readSaasTenantSecret(executor, input, repositoryOptions),
    );
  } finally {
    await pool.end();
  }
}
