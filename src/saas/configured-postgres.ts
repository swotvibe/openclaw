import { resolveSaasDatabaseConfig, type SaasDatabaseConfigIssue } from "./feature-flags.js";
import { resolveConfiguredSaasKmsProvider } from "./kms.js";
import type { AppliedSaasPostgresMigration } from "./postgres-migration-plan.js";
import type { RunSaasPostgresMigrationsResult } from "./postgres-migration-runner.js";
import {
  loadAppliedSaasPostgresMigrationsReadOnlyWithPg,
  loadAppliedSaasPostgresMigrationsWithPg,
  provisionSaasTenantWithPg,
  readSaasTenantSecretWithPg,
  runSaasRlsIsolationSmokeWithPg,
  runSaasPostgresMigrationsWithPg,
  writeSaasTenantSecretWithPg,
  type SaasPostgresPoolOptions,
} from "./postgres-pg-executor.js";
import type { SaasRlsIsolationSmokeResult } from "./rls-smoke.js";
import type {
  SaasTenantProvisioningInput,
  SaasTenantProvisioningResult,
} from "./tenant-provisioning.js";
import type {
  SaasTenantSecretReadInput,
  SaasTenantSecretReadResult,
  SaasTenantSecretWriteInput,
  SaasTenantSecretWriteResult,
} from "./tenant-secrets.js";

export class SaasDatabaseConfigurationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly SaasDatabaseConfigIssue[],
  ) {
    super(message);
    this.name = "SaasDatabaseConfigurationError";
  }
}

export function resolveConfiguredSaasTenantDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const config = resolveSaasDatabaseConfig(env);
  const blockingIssues = config.issues.filter((issue) => issue.severity === "error");
  if (blockingIssues.length > 0 || !config.tenantDatabaseUrl) {
    throw new SaasDatabaseConfigurationError(
      blockingIssues.length > 0
        ? blockingIssues.map((issue) => issue.message).join(" ")
        : "SaaS tenant database is not configured.",
      blockingIssues,
    );
  }
  return config.tenantDatabaseUrl;
}

export async function loadConfiguredSaasPostgresMigrations(
  params: {
    env?: NodeJS.ProcessEnv;
    poolOptions?: SaasPostgresPoolOptions;
  } = {},
): Promise<readonly AppliedSaasPostgresMigration[]> {
  return await loadAppliedSaasPostgresMigrationsWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(params.env),
    params.poolOptions,
  );
}

export async function loadConfiguredSaasPostgresMigrationsReadOnly(
  params: {
    env?: NodeJS.ProcessEnv;
    poolOptions?: SaasPostgresPoolOptions;
  } = {},
): Promise<readonly AppliedSaasPostgresMigration[]> {
  return await loadAppliedSaasPostgresMigrationsReadOnlyWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(params.env),
    params.poolOptions,
  );
}

export async function runConfiguredSaasPostgresMigrations(
  params: {
    env?: NodeJS.ProcessEnv;
    poolOptions?: SaasPostgresPoolOptions;
  } = {},
): Promise<RunSaasPostgresMigrationsResult> {
  return await runSaasPostgresMigrationsWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(params.env),
    params.poolOptions,
  );
}

export async function provisionConfiguredSaasTenant(params: {
  input: SaasTenantProvisioningInput;
  env?: NodeJS.ProcessEnv;
  poolOptions?: SaasPostgresPoolOptions;
}): Promise<SaasTenantProvisioningResult> {
  const env = params.env ?? process.env;
  return await provisionSaasTenantWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(env),
    params.input,
    {
      kmsProvider: resolveConfiguredSaasKmsProvider(env),
    },
    params.poolOptions,
  );
}

export async function runConfiguredSaasRlsIsolationSmoke(
  params: {
    env?: NodeJS.ProcessEnv;
    poolOptions?: SaasPostgresPoolOptions;
  } = {},
): Promise<SaasRlsIsolationSmokeResult> {
  return await runSaasRlsIsolationSmokeWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(params.env),
    params.poolOptions,
  );
}

export async function writeConfiguredSaasTenantSecret(params: {
  input: SaasTenantSecretWriteInput;
  env?: NodeJS.ProcessEnv;
  poolOptions?: SaasPostgresPoolOptions;
}): Promise<SaasTenantSecretWriteResult> {
  const env = params.env ?? process.env;
  return await writeSaasTenantSecretWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(env),
    params.input,
    {
      kmsProvider: resolveConfiguredSaasKmsProvider(env),
    },
    params.poolOptions,
  );
}

export async function readConfiguredSaasTenantSecret(params: {
  input: SaasTenantSecretReadInput;
  env?: NodeJS.ProcessEnv;
  poolOptions?: SaasPostgresPoolOptions;
}): Promise<SaasTenantSecretReadResult | null> {
  const env = params.env ?? process.env;
  return await readSaasTenantSecretWithPg(
    resolveConfiguredSaasTenantDatabaseUrl(env),
    params.input,
    {
      kmsProvider: resolveConfiguredSaasKmsProvider(env),
    },
    params.poolOptions,
  );
}
