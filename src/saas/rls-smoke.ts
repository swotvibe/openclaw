import { randomUUID } from "node:crypto";
import type { SaasPostgresQueryExecutor } from "./postgres-migration-runner.js";
import {
  createPostgresSetTenantContextQuery,
  parseTenantId,
  type TenantId,
} from "./tenant-context.js";

export type SaasRlsIsolationSmokeCheck = {
  tenantId: TenantId;
  visibleTenantIds: readonly TenantId[];
  expectedVisibleTenantIds: readonly TenantId[];
  ok: boolean;
};

export type SaasRlsIsolationSmokeIssueCode =
  | "tenant_a_visibility_mismatch"
  | "tenant_b_visibility_mismatch";

export type SaasRlsIsolationSmokeIssue = {
  code: SaasRlsIsolationSmokeIssueCode;
  message: string;
};

export type SaasRlsIsolationSmokeResult = {
  ok: boolean;
  rolledBack: true;
  currentUser?: string;
  sessionUser?: string;
  tenantA: TenantId;
  tenantB: TenantId;
  checks: readonly SaasRlsIsolationSmokeCheck[];
  issues: readonly SaasRlsIsolationSmokeIssue[];
};

type RoleRow = {
  current_user: unknown;
  session_user: unknown;
};

type TenantIdRow = {
  id: unknown;
};

export class SaasRlsIsolationSmokeError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaasRlsIsolationSmokeError";
  }
}

function createSmokeTenantId(): TenantId {
  return parseTenantId(randomUUID());
}

function createSmokeTenantSlug(prefix: string, tenantId: TenantId): string {
  return `rls-smoke-${prefix}-${tenantId.replaceAll("-", "").slice(0, 16)}`;
}

async function rollbackBestEffort(executor: SaasPostgresQueryExecutor): Promise<void> {
  try {
    await executor.query("ROLLBACK");
  } catch {
    // Preserve the original RLS smoke failure.
  }
}

async function setTenantContext(
  executor: SaasPostgresQueryExecutor,
  tenantId: TenantId,
): Promise<void> {
  const query = createPostgresSetTenantContextQuery(tenantId);
  await executor.query(query.text, query.values);
}

async function insertSmokeTenant(
  executor: SaasPostgresQueryExecutor,
  params: {
    tenantId: TenantId;
    slug: string;
    displayName: string;
  },
): Promise<void> {
  await executor.query(
    `
INSERT INTO openclaw_saas.tenants (id, slug, display_name, status)
VALUES ($1, $2, $3, 'active')
`.trim(),
    [params.tenantId, params.slug, params.displayName],
  );
}

async function selectVisibleSmokeTenantIds(
  executor: SaasPostgresQueryExecutor,
  tenantA: TenantId,
  tenantB: TenantId,
): Promise<readonly TenantId[]> {
  const result = await executor.query<TenantIdRow>(
    `
SELECT id::text AS id
FROM openclaw_saas.tenants
WHERE id IN ($1::uuid, $2::uuid)
ORDER BY id
`.trim(),
    [tenantA, tenantB],
  );
  return result.rows.map((row) => {
    if (typeof row.id !== "string") {
      throw new SaasRlsIsolationSmokeError("Invalid SaaS RLS smoke tenant row.");
    }
    return parseTenantId(row.id);
  });
}

function sameTenantIds(left: readonly TenantId[], right: readonly TenantId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function createVisibilityCheck(
  tenantId: TenantId,
  visibleTenantIds: readonly TenantId[],
): SaasRlsIsolationSmokeCheck {
  const expectedVisibleTenantIds = [tenantId];
  return {
    tenantId,
    visibleTenantIds,
    expectedVisibleTenantIds,
    ok: sameTenantIds(visibleTenantIds, expectedVisibleTenantIds),
  };
}

function buildIssues(
  tenantACheck: SaasRlsIsolationSmokeCheck,
  tenantBCheck: SaasRlsIsolationSmokeCheck,
): SaasRlsIsolationSmokeIssue[] {
  const issues: SaasRlsIsolationSmokeIssue[] = [];
  if (!tenantACheck.ok) {
    issues.push({
      code: "tenant_a_visibility_mismatch",
      message: `Tenant A context saw ${tenantACheck.visibleTenantIds.length} smoke tenant rows instead of exactly itself.`,
    });
  }
  if (!tenantBCheck.ok) {
    issues.push({
      code: "tenant_b_visibility_mismatch",
      message: `Tenant B context saw ${tenantBCheck.visibleTenantIds.length} smoke tenant rows instead of exactly itself.`,
    });
  }
  return issues;
}

export async function runSaasRlsIsolationSmoke(
  executor: SaasPostgresQueryExecutor,
): Promise<SaasRlsIsolationSmokeResult> {
  const tenantA = createSmokeTenantId();
  const tenantB = createSmokeTenantId();
  await executor.query("BEGIN");

  try {
    const roleResult = await executor.query<RoleRow>(
      "SELECT current_user::text AS current_user, session_user::text AS session_user",
    );
    const role = roleResult.rows[0];

    await setTenantContext(executor, tenantA);
    await insertSmokeTenant(executor, {
      tenantId: tenantA,
      slug: createSmokeTenantSlug("a", tenantA),
      displayName: "OpenClaw RLS Smoke Tenant A",
    });

    await setTenantContext(executor, tenantB);
    await insertSmokeTenant(executor, {
      tenantId: tenantB,
      slug: createSmokeTenantSlug("b", tenantB),
      displayName: "OpenClaw RLS Smoke Tenant B",
    });

    await setTenantContext(executor, tenantA);
    const tenantACheck = createVisibilityCheck(
      tenantA,
      await selectVisibleSmokeTenantIds(executor, tenantA, tenantB),
    );

    await setTenantContext(executor, tenantB);
    const tenantBCheck = createVisibilityCheck(
      tenantB,
      await selectVisibleSmokeTenantIds(executor, tenantA, tenantB),
    );

    await executor.query("ROLLBACK");
    const issues = buildIssues(tenantACheck, tenantBCheck);
    return {
      ok: issues.length === 0,
      rolledBack: true,
      ...(typeof role?.current_user === "string" ? { currentUser: role.current_user } : {}),
      ...(typeof role?.session_user === "string" ? { sessionUser: role.session_user } : {}),
      tenantA,
      tenantB,
      checks: [tenantACheck, tenantBCheck],
      issues,
    };
  } catch (error) {
    await rollbackBestEffort(executor);
    if (error instanceof SaasRlsIsolationSmokeError) {
      throw error;
    }
    throw new SaasRlsIsolationSmokeError("Failed to run SaaS RLS isolation smoke.", error);
  }
}
