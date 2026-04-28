import { loadConfiguredSaasPostgresMigrationsReadOnly } from "./configured-postgres.js";
import { resolveSaasDatabaseConfig } from "./feature-flags.js";
import type { SaasPostgresPoolOptions } from "./postgres-pg-executor.js";
import { resolveSaasReadiness, type SaasReadiness } from "./readiness.js";

export async function loadSaasReadinessWithPg(
  params: {
    env?: NodeJS.ProcessEnv;
    poolOptions?: SaasPostgresPoolOptions;
  } = {},
): Promise<SaasReadiness> {
  const env = params.env ?? process.env;
  const localReadiness = resolveSaasReadiness({ env });
  if (localReadiness.status === "disabled" || localReadiness.status === "blocked") {
    return localReadiness;
  }

  const database = resolveSaasDatabaseConfig(env);
  if (!database.tenantDatabaseUrl) {
    return localReadiness;
  }

  const appliedMigrations = await loadConfiguredSaasPostgresMigrationsReadOnly({
    env,
    poolOptions: params.poolOptions,
  });
  return resolveSaasReadiness({
    env,
    appliedMigrations,
  });
}
