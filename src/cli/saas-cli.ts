import type { Command } from "commander";
import { loadDotEnv } from "../infra/dotenv.js";
import { defaultRuntime } from "../runtime.js";
import {
  provisionConfiguredSaasTenant,
  runConfiguredSaasRlsIsolationSmoke,
  runConfiguredSaasPostgresMigrations,
} from "../saas/configured-postgres.js";
import type { SaasDatabaseConfigIssue } from "../saas/feature-flags.js";
import { redactPostgresConnectionUrl } from "../saas/postgres-connection-url.js";
import type { AppliedSaasPostgresMigration } from "../saas/postgres-migration-plan.js";
import type { RunSaasPostgresMigrationsResult } from "../saas/postgres-migration-runner.js";
import { loadSaasReadinessWithPg } from "../saas/readiness-pg.js";
import {
  type SaasReadiness,
  type SaasReadinessStatus,
  resolveSaasReadiness,
} from "../saas/readiness.js";
import type { SaasRlsIsolationSmokeResult } from "../saas/rls-smoke.js";
import {
  buildSaasTenantProvisioningPlan,
  type SaasTenantProvisioningInput,
  type SaasTenantProvisioningPlan,
  type SaasTenantProvisioningResult,
} from "../saas/tenant-provisioning.js";
import { formatDocsLink } from "../terminal/links.js";
import { isRich, theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { formatHelpExamples } from "./help-format.js";

type SaasStatusOptions = {
  json?: boolean;
  live?: boolean;
};

type SaasMigrateOptions = {
  json?: boolean;
  yes?: boolean;
};

type SaasRlsCheckOptions = {
  json?: boolean;
};

type SaasTenantCreateOptions = {
  json?: boolean;
  yes?: boolean;
  tenantId?: string;
  slug?: string;
  name?: string;
  ownerUserId?: string;
  agentId?: string;
  agentName?: string;
};

type SaasCliConnectionSnapshot = {
  configured: boolean;
  source?: "connection-url" | "host-parts";
  url?: string;
  issues: readonly {
    code: string;
    severity: "error" | "warn";
    message: string;
  }[];
};

type SaasCliDatabaseSnapshot = {
  saasMode: boolean;
  tenantDatabaseConfigured: boolean;
  serviceDatabaseConfigured: boolean;
  tenant: SaasCliConnectionSnapshot;
  service: SaasCliConnectionSnapshot;
  issues: readonly SaasDatabaseConfigIssue[];
};

type SaasCliMigrationSnapshot = {
  applied: readonly AppliedSaasPostgresMigration[];
  pending: readonly { id: string }[];
  issues: SaasReadiness["migrations"]["issues"];
};

function loadSaasCliEnv(): void {
  loadDotEnv({ quiet: true });
}

function statusText(status: SaasReadinessStatus): string {
  switch (status) {
    case "disabled":
      return "disabled";
    case "blocked":
      return "blocked";
    case "needs_migration":
      return "needs migration";
    case "ready":
      return "ready";
  }
}

function colorStatus(status: SaasReadinessStatus): string {
  const text = statusText(status);
  if (!isRich()) {
    return text;
  }
  switch (status) {
    case "ready":
      return theme.success(text);
    case "needs_migration":
      return theme.warn(text);
    case "blocked":
      return theme.error(text);
    case "disabled":
      return theme.muted(text);
  }
}

function sanitizeErrorText(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return raw.replace(/postgres(?:ql)?:\/\/[^\s'")]+/gi, (match) =>
    redactPostgresConnectionUrl(match),
  );
}

function toConnectionSnapshot(
  connection: SaasReadiness["database"]["tenantConnection"],
): SaasCliConnectionSnapshot {
  return {
    configured: connection.configured,
    ...(connection.source ? { source: connection.source } : {}),
    ...(connection.redactedConnectionUrl ? { url: connection.redactedConnectionUrl } : {}),
    issues: connection.issues,
  };
}

function toDatabaseSnapshot(readiness: SaasReadiness): SaasCliDatabaseSnapshot {
  return {
    saasMode: readiness.database.saasMode,
    tenantDatabaseConfigured: readiness.database.tenantDatabaseConfigured,
    serviceDatabaseConfigured: readiness.database.serviceDatabaseConfigured,
    tenant: toConnectionSnapshot(readiness.database.tenantConnection),
    service: toConnectionSnapshot(readiness.database.serviceConnection),
    issues: readiness.database.issues,
  };
}

function toMigrationSnapshot(readiness: SaasReadiness): SaasCliMigrationSnapshot {
  return {
    applied: readiness.migrations.applied,
    pending: readiness.migrations.pending.map((migration) => ({ id: migration.id })),
    issues: readiness.migrations.issues,
  };
}

function toStatusJson(readiness: SaasReadiness, options: { live: boolean }) {
  return {
    status: readiness.status,
    live: options.live,
    flags: readiness.flags,
    database: toDatabaseSnapshot(readiness),
    migrations: toMigrationSnapshot(readiness),
  };
}

function formatIssues(
  issues: readonly { severity: "error" | "warn"; code: string; message: string }[],
): string[] {
  if (issues.length === 0) {
    return [];
  }
  const rich = isRich();
  return issues.map((issue) => {
    const label =
      issue.severity === "error"
        ? rich
          ? theme.error("error")
          : "error"
        : rich
          ? theme.warn("warn")
          : "warn";
    return `  [${label}] ${issue.code}: ${issue.message}`;
  });
}

function formatMigrationIds(
  label: string,
  migrations: readonly { id: string }[],
  emptyText: string,
): string {
  if (migrations.length === 0) {
    return `${label}: ${emptyText}`;
  }
  return `${label}: ${migrations.map((migration) => migration.id).join(", ")}`;
}

function renderSaasStatus(readiness: SaasReadiness, options: { live: boolean }): string {
  const lines: string[] = [];
  lines.push(isRich() ? theme.heading("OpenClaw SaaS") : "OpenClaw SaaS");
  lines.push(`Status: ${colorStatus(readiness.status)}`);
  lines.push(`Mode: ${readiness.flags.saasMode ? "enabled" : "disabled"}`);
  lines.push(`Check: ${options.live ? "live PostgreSQL ledger (read-only)" : "local environment"}`);

  const tenant = readiness.database.tenantConnection;
  const service = readiness.database.serviceConnection;
  lines.push(
    `Tenant database: ${tenant.configured ? (tenant.redactedConnectionUrl ?? "configured") : "not configured"}`,
  );
  lines.push(
    `Service database: ${service.configured ? (service.redactedConnectionUrl ?? "configured") : "not configured"}`,
  );
  lines.push(formatMigrationIds("Applied migrations", readiness.migrations.applied, "none"));
  lines.push(formatMigrationIds("Pending migrations", readiness.migrations.pending, "none"));

  const allIssues = [...readiness.database.issues, ...readiness.migrations.issues];
  if (allIssues.length > 0) {
    lines.push("");
    lines.push(isRich() ? theme.heading("Issues") : "Issues");
    lines.push(...formatIssues(allIssues));
  }

  if (!options.live && readiness.flags.saasMode && readiness.database.tenantDatabaseConfigured) {
    lines.push("");
    lines.push(
      `Use ${formatCliCommand("openclaw saas status --live")} to read the PostgreSQL migration ledger.`,
    );
  }

  if (readiness.status === "needs_migration") {
    lines.push(`Apply migrations: ${formatCliCommand("openclaw saas migrate --yes")}`);
  } else if (readiness.status === "disabled") {
    lines.push("Set OPENCLAW_SAAS_MODE=1 before running SaaS database migrations.");
  }

  return lines.join("\n");
}

function renderDryRun(readiness: SaasReadiness): string {
  const lines = renderSaasStatus(readiness, { live: true }).split("\n");
  lines.push("");
  lines.push("Dry-run only: no database changes were applied.");
  if (readiness.status === "needs_migration") {
    lines.push(`Re-run with ${formatCliCommand("openclaw saas migrate --yes")} to apply.`);
  }
  return lines.join("\n");
}

function renderMigrationResult(result: RunSaasPostgresMigrationsResult): string {
  const lines: string[] = [];
  lines.push(isRich() ? theme.heading("OpenClaw SaaS migrations") : "OpenClaw SaaS migrations");
  lines.push(formatMigrationIds("Pending before run", result.pendingBeforeRun, "none"));
  lines.push(formatMigrationIds("Applied", result.applied, "none"));
  if (result.applied.length === 0) {
    lines.push("Database schema was already current.");
  }
  return lines.join("\n");
}

function toMigrationResultJson(result: RunSaasPostgresMigrationsResult) {
  return {
    ok: true,
    dryRun: false,
    pendingBeforeRun: result.pendingBeforeRun.map((migration) => ({
      id: migration.id,
      description: migration.description,
    })),
    applied: result.applied,
  };
}

function toRlsSmokeJson(result: SaasRlsIsolationSmokeResult) {
  return {
    ok: result.ok,
    rolledBack: result.rolledBack,
    ...(result.currentUser ? { currentUser: result.currentUser } : {}),
    ...(result.sessionUser ? { sessionUser: result.sessionUser } : {}),
    checks: result.checks,
    issues: result.issues,
  };
}

function renderRlsSmokeResult(result: SaasRlsIsolationSmokeResult): string {
  const lines: string[] = [];
  lines.push(isRich() ? theme.heading("OpenClaw SaaS RLS check") : "OpenClaw SaaS RLS check");
  lines.push(
    `Status: ${result.ok ? (isRich() ? theme.success("passed") : "passed") : isRich() ? theme.error("failed") : "failed"}`,
  );
  lines.push("Rolled back: yes");
  if (result.currentUser) {
    lines.push(`Current user: ${result.currentUser}`);
  }
  if (result.sessionUser && result.sessionUser !== result.currentUser) {
    lines.push(`Session user: ${result.sessionUser}`);
  }
  for (const check of result.checks) {
    lines.push(
      `Tenant ${check.tenantId}: saw ${check.visibleTenantIds.length} smoke tenant row(s)`,
    );
  }
  if (result.issues.length > 0) {
    lines.push("");
    lines.push(isRich() ? theme.heading("Issues") : "Issues");
    for (const issue of result.issues) {
      lines.push(`  [error] ${issue.code}: ${issue.message}`);
    }
  }
  return lines.join("\n");
}

function toTenantProvisioningJson(
  payload: SaasTenantProvisioningPlan | SaasTenantProvisioningResult,
  options: { dryRun: boolean },
) {
  return {
    ok: "created" in payload ? payload.created : true,
    dryRun: options.dryRun,
    tenantId: payload.tenantId,
    slug: payload.slug,
    displayName: payload.displayName,
    ownerUserId: payload.ownerUserId,
    ...(payload.agent ? { agent: payload.agent } : {}),
  };
}

function renderTenantProvisioningPlan(plan: SaasTenantProvisioningPlan): string {
  const lines: string[] = [];
  lines.push(
    isRich()
      ? theme.heading("OpenClaw SaaS tenant provisioning")
      : "OpenClaw SaaS tenant provisioning",
  );
  lines.push(`Tenant id: ${plan.tenantId}`);
  lines.push(`Slug: ${plan.slug}`);
  lines.push(`Display name: ${plan.displayName}`);
  lines.push(`Owner user id: ${plan.ownerUserId}`);
  if (plan.agent) {
    lines.push(`Default agent: ${plan.agent.agentId} (${plan.agent.displayName})`);
  }
  lines.push("");
  lines.push("Dry-run only: no database changes were applied.");
  lines.push(`Re-run with ${formatCliCommand("openclaw saas tenant create ... --yes")} to apply.`);
  return lines.join("\n");
}

function renderTenantProvisioningResult(result: SaasTenantProvisioningResult): string {
  const lines: string[] = [];
  lines.push(
    isRich() ? theme.heading("OpenClaw SaaS tenant created") : "OpenClaw SaaS tenant created",
  );
  lines.push(`Tenant id: ${result.tenantId}`);
  lines.push(`Slug: ${result.slug}`);
  lines.push(`Display name: ${result.displayName}`);
  lines.push(`Owner user id: ${result.ownerUserId}`);
  if (result.agent) {
    lines.push(`Default agent: ${result.agent.agentId} (${result.agent.displayName})`);
  }
  return lines.join("\n");
}

function toTenantProvisioningInput(options: SaasTenantCreateOptions): SaasTenantProvisioningInput {
  return {
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    slug: options.slug ?? "",
    displayName: options.name ?? "",
    ownerUserId: options.ownerUserId ?? "",
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.agentName ? { agentDisplayName: options.agentName } : {}),
  };
}

function toTenantProvisioningInputFromPlan(
  plan: SaasTenantProvisioningPlan,
): SaasTenantProvisioningInput {
  return {
    tenantId: plan.tenantId,
    slug: plan.slug,
    displayName: plan.displayName,
    ownerUserId: plan.ownerUserId,
    ...(plan.agent
      ? {
          agentId: plan.agent.agentId,
          agentDisplayName: plan.agent.displayName,
        }
      : {}),
  };
}

function shouldExitNonZero(readiness: SaasReadiness): boolean {
  return readiness.status === "blocked" || readiness.status === "disabled";
}

function emitCommandError(message: string, options: { json?: boolean }) {
  if (options.json) {
    defaultRuntime.writeJson({ ok: false, error: message });
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(1);
}

export function registerSaasCli(program: Command) {
  const saas = program
    .command("saas")
    .description("Inspect and migrate SaaS PostgreSQL state")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw saas status", "Check SaaS feature flags and local database configuration."],
          ["openclaw saas status --live", "Read the PostgreSQL migration ledger without writes."],
          ["openclaw saas status --json", "Print machine-readable status without secrets."],
          ["openclaw saas migrate", "Preview pending PostgreSQL migrations."],
          ["openclaw saas migrate --yes", "Apply pending PostgreSQL migrations."],
          ["openclaw saas rls-check", "Run rollback-only tenant RLS isolation smoke."],
          [
            "openclaw saas tenant create --slug acme --name Acme --owner-user-id user@example.com",
            "Preview tenant provisioning.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/saas", "docs.openclaw.ai/cli/saas")}\n`,
    );

  saas
    .command("status")
    .description("Show SaaS mode, database configuration, and migration readiness")
    .option("--live", "Read migration status from PostgreSQL without applying migrations", false)
    .option("--json", "Print JSON", false)
    .action(async (options: SaasStatusOptions) => {
      loadSaasCliEnv();
      const live = Boolean(options.live);
      let readiness: SaasReadiness;
      try {
        readiness = live ? await loadSaasReadinessWithPg() : resolveSaasReadiness();
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
        return;
      }

      if (options.json) {
        defaultRuntime.writeJson(toStatusJson(readiness, { live }));
      } else {
        defaultRuntime.log(renderSaasStatus(readiness, { live }));
      }
      if (shouldExitNonZero(readiness)) {
        defaultRuntime.exit(1);
      }
    });

  saas
    .command("migrate")
    .description("Preview or apply SaaS PostgreSQL migrations")
    .option("--yes", "Apply migrations instead of dry-running", false)
    .option("--json", "Print JSON", false)
    .action(async (options: SaasMigrateOptions) => {
      loadSaasCliEnv();
      if (!options.yes) {
        let readiness: SaasReadiness;
        try {
          readiness = await loadSaasReadinessWithPg();
        } catch (error) {
          emitCommandError(sanitizeErrorText(error), { json: options.json });
          return;
        }

        if (options.json) {
          defaultRuntime.writeJson({
            ok: !shouldExitNonZero(readiness),
            dryRun: true,
            ...toStatusJson(readiness, { live: true }),
          });
        } else {
          defaultRuntime.log(renderDryRun(readiness));
        }
        if (shouldExitNonZero(readiness)) {
          defaultRuntime.exit(1);
        }
        return;
      }

      const preflight = resolveSaasReadiness();
      if (shouldExitNonZero(preflight)) {
        if (options.json) {
          defaultRuntime.writeJson({
            ok: false,
            dryRun: false,
            ...toStatusJson(preflight, { live: false }),
          });
        } else {
          defaultRuntime.error(renderSaasStatus(preflight, { live: false }));
        }
        defaultRuntime.exit(1);
        return;
      }

      try {
        const result = await runConfiguredSaasPostgresMigrations();
        if (options.json) {
          defaultRuntime.writeJson(toMigrationResultJson(result));
        } else {
          defaultRuntime.log(renderMigrationResult(result));
        }
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
      }
    });

  saas
    .command("rls-check")
    .description("Run a rollback-only PostgreSQL RLS isolation smoke")
    .option("--json", "Print JSON", false)
    .action(async (options: SaasRlsCheckOptions) => {
      loadSaasCliEnv();
      let readiness: SaasReadiness;
      try {
        readiness = await loadSaasReadinessWithPg();
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
        return;
      }

      if (readiness.status !== "ready") {
        const message =
          readiness.status === "needs_migration"
            ? `SaaS database has pending migrations. Run ${formatCliCommand("openclaw saas migrate --yes")} first.`
            : renderSaasStatus(readiness, { live: true });
        if (options.json) {
          defaultRuntime.writeJson({
            ok: false,
            error: message,
            ...toStatusJson(readiness, { live: true }),
          });
        } else {
          defaultRuntime.error(message);
        }
        defaultRuntime.exit(1);
        return;
      }

      let result: SaasRlsIsolationSmokeResult;
      try {
        result = await runConfiguredSaasRlsIsolationSmoke();
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
        return;
      }

      if (options.json) {
        defaultRuntime.writeJson(toRlsSmokeJson(result));
      } else {
        defaultRuntime.log(renderRlsSmokeResult(result));
      }
      if (!result.ok) {
        defaultRuntime.exit(1);
      }
    });

  const tenant = saas.command("tenant").description("Provision and inspect SaaS tenants");

  tenant
    .command("create")
    .description("Preview or create a SaaS tenant, owner membership, and optional default agent")
    .requiredOption("--slug <slug>", "Tenant slug")
    .requiredOption("--name <name>", "Tenant display name")
    .requiredOption("--owner-user-id <id>", "Initial owner user identifier")
    .option("--tenant-id <uuid>", "Explicit tenant UUID; generated when omitted")
    .option("--agent-id <id>", "Optional default agent id to create")
    .option("--agent-name <name>", "Default agent display name when --agent-id is set")
    .option("--yes", "Apply provisioning instead of dry-running", false)
    .option("--json", "Print JSON", false)
    .action(async (options: SaasTenantCreateOptions) => {
      loadSaasCliEnv();
      const input = toTenantProvisioningInput(options);
      let plan: SaasTenantProvisioningPlan;
      try {
        plan = buildSaasTenantProvisioningPlan(input);
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
        return;
      }

      if (!options.yes) {
        if (options.json) {
          defaultRuntime.writeJson(toTenantProvisioningJson(plan, { dryRun: true }));
        } else {
          defaultRuntime.log(renderTenantProvisioningPlan(plan));
        }
        return;
      }

      let readiness: SaasReadiness;
      try {
        readiness = await loadSaasReadinessWithPg();
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
        return;
      }

      if (readiness.status !== "ready") {
        const message =
          readiness.status === "needs_migration"
            ? `SaaS database has pending migrations. Run ${formatCliCommand("openclaw saas migrate --yes")} first.`
            : renderSaasStatus(readiness, { live: true });
        if (options.json) {
          defaultRuntime.writeJson({
            ok: false,
            dryRun: false,
            error: message,
            ...toStatusJson(readiness, { live: true }),
          });
        } else {
          defaultRuntime.error(message);
        }
        defaultRuntime.exit(1);
        return;
      }

      try {
        const result = await provisionConfiguredSaasTenant({
          input: toTenantProvisioningInputFromPlan(plan),
        });
        if (options.json) {
          defaultRuntime.writeJson(toTenantProvisioningJson(result, { dryRun: false }));
        } else {
          defaultRuntime.log(renderTenantProvisioningResult(result));
        }
      } catch (error) {
        emitCommandError(sanitizeErrorText(error), { json: options.json });
      }
    });
}
