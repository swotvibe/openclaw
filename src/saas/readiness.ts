import { resolveSaasDatabaseConfig, resolveSaasFeatureFlags } from "./feature-flags.js";
import {
  type AppliedSaasPostgresMigration,
  buildSaasPostgresMigrationPlan,
} from "./postgres-migration-plan.js";

export type SaasReadinessStatus = "disabled" | "blocked" | "needs_migration" | "ready";

export type ResolveSaasReadinessOptions = {
  env?: NodeJS.ProcessEnv;
  appliedMigrations?: Iterable<AppliedSaasPostgresMigration>;
};

export type SaasReadiness = {
  status: SaasReadinessStatus;
  flags: ReturnType<typeof resolveSaasFeatureFlags>;
  database: ReturnType<typeof resolveSaasDatabaseConfig>;
  migrations: ReturnType<typeof buildSaasPostgresMigrationPlan>;
};

export function resolveSaasReadiness(options: ResolveSaasReadinessOptions = {}): SaasReadiness {
  const env = options.env ?? process.env;
  const flags = resolveSaasFeatureFlags(env);
  const database = resolveSaasDatabaseConfig(env);
  const migrations = buildSaasPostgresMigrationPlan(options.appliedMigrations ?? []);

  if (!flags.saasMode) {
    return {
      status: "disabled",
      flags,
      database,
      migrations,
    };
  }

  const hasBlockingIssue =
    database.issues.some((issue) => issue.severity === "error") || migrations.issues.length > 0;

  if (!flags.databaseEnabled || hasBlockingIssue) {
    return {
      status: "blocked",
      flags,
      database,
      migrations,
    };
  }

  return {
    status: migrations.pending.length > 0 ? "needs_migration" : "ready",
    flags,
    database,
    migrations,
  };
}
