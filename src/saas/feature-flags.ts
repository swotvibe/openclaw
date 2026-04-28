import { isTruthyEnvValue } from "../infra/env.js";
import {
  type SaasPostgresConnection,
  resolveSaasPostgresConnection,
} from "./postgres-connection-url.js";

export type SaasFeatureFlags = {
  saasMode: boolean;
  databaseEnabled: boolean;
  configStoreDual: boolean;
  configStoreDb: boolean;
  sessionStoreDual: boolean;
  sessionStoreDb: boolean;
  secretsVault: boolean;
  taskRegistryDb: boolean;
  channelIsolation: boolean;
  mediaIsolation: boolean;
  memoryIsolation: boolean;
  billingEnabled: boolean;
  usageMeteringEnabled: boolean;
};

export type SaasDatabaseConfigIssueCode =
  | "tenant_database_missing"
  | "tenant_database_invalid"
  | "service_database_missing"
  | "service_database_invalid"
  | "service_database_matches_tenant";

export type SaasDatabaseConfigIssue = {
  code: SaasDatabaseConfigIssueCode;
  severity: "error" | "warn";
  message: string;
};

export type SaasDatabaseConfig = {
  saasMode: boolean;
  tenantDatabaseConfigured: boolean;
  serviceDatabaseConfigured: boolean;
  tenantConnection: SaasPostgresConnection;
  serviceConnection: SaasPostgresConnection;
  tenantDatabaseUrl?: string;
  tenantDatabaseUrlRedacted?: string;
  serviceDatabaseUrl?: string;
  serviceDatabaseUrlRedacted?: string;
  issues: SaasDatabaseConfigIssue[];
};

function enabledInSaasMode(env: NodeJS.ProcessEnv, key: string, saasMode: boolean): boolean {
  return saasMode && isTruthyEnvValue(env[key]);
}

export function resolveSaasFeatureFlags(env: NodeJS.ProcessEnv = process.env): SaasFeatureFlags {
  const saasMode = isTruthyEnvValue(env.OPENCLAW_SAAS_MODE);
  const tenantConnection = resolveSaasPostgresConnection(env);

  return {
    saasMode,
    databaseEnabled: saasMode && tenantConnection.configured,
    configStoreDual: enabledInSaasMode(env, "OPENCLAW_CONFIG_STORE_DUAL", saasMode),
    configStoreDb: enabledInSaasMode(env, "OPENCLAW_CONFIG_STORE_DB", saasMode),
    sessionStoreDual: enabledInSaasMode(env, "OPENCLAW_SESSION_STORE_DUAL", saasMode),
    sessionStoreDb: enabledInSaasMode(env, "OPENCLAW_SESSION_STORE_DB", saasMode),
    secretsVault: enabledInSaasMode(env, "OPENCLAW_SECRETS_VAULT", saasMode),
    taskRegistryDb: enabledInSaasMode(env, "OPENCLAW_TASK_REGISTRY_DB", saasMode),
    channelIsolation: enabledInSaasMode(env, "OPENCLAW_CHANNEL_ISOLATION", saasMode),
    mediaIsolation: enabledInSaasMode(env, "OPENCLAW_MEDIA_ISOLATION", saasMode),
    memoryIsolation: enabledInSaasMode(env, "OPENCLAW_MEMORY_ISOLATION", saasMode),
    billingEnabled: enabledInSaasMode(env, "OPENCLAW_BILLING", saasMode),
    usageMeteringEnabled: enabledInSaasMode(env, "OPENCLAW_USAGE_METERING", saasMode),
  };
}

export function resolveSaasDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): SaasDatabaseConfig {
  const saasMode = isTruthyEnvValue(env.OPENCLAW_SAAS_MODE);
  const tenantConnection = resolveSaasPostgresConnection(env);
  const serviceConnection = resolveSaasPostgresConnection(env, {
    envKeys: {
      connectionUrl: "OPENCLAW_SERVICE_DATABASE_URL",
      host: "OPENCLAW_SERVICE_POSTGRES_HOST",
      port: "OPENCLAW_SERVICE_POSTGRES_PORT",
      database: "OPENCLAW_SERVICE_POSTGRES_DATABASE",
      user: "OPENCLAW_SERVICE_POSTGRES_USER",
      password: "OPENCLAW_SERVICE_POSTGRES_PASSWORD",
      sslMode: "OPENCLAW_SERVICE_POSTGRES_SSLMODE",
    },
    defaultUser: "openclaw_service",
  });
  const issues: SaasDatabaseConfigIssue[] = [];

  if (saasMode && !tenantConnection.configured && tenantConnection.issues.length === 0) {
    issues.push({
      code: "tenant_database_missing",
      severity: "error",
      message:
        "OPENCLAW_SAAS_MODE is enabled but neither DATABASE_URL nor OPENCLAW_POSTGRES_HOST is configured.",
    });
  }

  if (saasMode && tenantConnection.issues.some((issue) => issue.severity === "error")) {
    issues.push({
      code: "tenant_database_invalid",
      severity: "error",
      message: tenantConnection.issues.map((issue) => issue.message).join(" "),
    });
  }

  if (saasMode && tenantConnection.configured && !serviceConnection.configured) {
    issues.push({
      code: "service_database_missing",
      severity: "warn",
      message:
        "OPENCLAW_SERVICE_DATABASE_URL or OPENCLAW_SERVICE_POSTGRES_HOST is not configured; cross-tenant service work must not use the tenant request role.",
    });
  }

  if (saasMode && serviceConnection.issues.some((issue) => issue.severity === "error")) {
    issues.push({
      code: "service_database_invalid",
      severity: "error",
      message: serviceConnection.issues.map((issue) => issue.message).join(" "),
    });
  }

  if (
    saasMode &&
    tenantConnection.connectionUrl &&
    serviceConnection.connectionUrl &&
    tenantConnection.connectionUrl === serviceConnection.connectionUrl
  ) {
    issues.push({
      code: "service_database_matches_tenant",
      severity: "error",
      message:
        "DATABASE_URL and OPENCLAW_SERVICE_DATABASE_URL must use separate database roles or connection strings.",
    });
  }

  return {
    saasMode,
    tenantDatabaseConfigured: tenantConnection.configured,
    serviceDatabaseConfigured: serviceConnection.configured,
    tenantConnection,
    serviceConnection,
    ...(tenantConnection.connectionUrl
      ? { tenantDatabaseUrl: tenantConnection.connectionUrl }
      : {}),
    ...(tenantConnection.redactedConnectionUrl
      ? { tenantDatabaseUrlRedacted: tenantConnection.redactedConnectionUrl }
      : {}),
    ...(serviceConnection.connectionUrl
      ? { serviceDatabaseUrl: serviceConnection.connectionUrl }
      : {}),
    ...(serviceConnection.redactedConnectionUrl
      ? { serviceDatabaseUrlRedacted: serviceConnection.redactedConnectionUrl }
      : {}),
    issues,
  };
}
