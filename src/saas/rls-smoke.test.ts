import { describe, expect, it } from "vitest";
import type { SaasPostgresQueryExecutor } from "./postgres-migration-runner.js";
import { runSaasRlsIsolationSmoke } from "./rls-smoke.js";

type QueryCall = {
  sql: string;
  params?: readonly unknown[];
};

function createExecutor(params: { bypassRls?: boolean } = {}): SaasPostgresQueryExecutor & {
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const insertedTenantIds: string[] = [];
  let currentTenantId: string | undefined;

  return {
    calls,
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams?: readonly unknown[],
    ) {
      calls.push(queryParams ? { sql, params: queryParams } : { sql });
      if (sql.startsWith("SELECT current_user")) {
        return {
          rows: [
            {
              current_user: "openclaw_tenant",
              session_user: "openclaw_tenant",
            },
          ] as unknown as readonly TRow[],
        };
      }
      if (sql.startsWith("select set_config")) {
        currentTenantId = String(queryParams?.[0]);
        return { rows: [] as readonly TRow[] };
      }
      if (sql.startsWith("INSERT INTO openclaw_saas.tenants")) {
        insertedTenantIds.push(String(queryParams?.[0]));
        return { rows: [] as readonly TRow[] };
      }
      if (sql.startsWith("SELECT id::text AS id")) {
        const visible = params.bypassRls
          ? insertedTenantIds
          : insertedTenantIds.filter((tenantId) => tenantId === currentTenantId);
        return {
          rows: visible.toSorted().map((id) => ({ id })) as unknown as readonly TRow[],
        };
      }
      return { rows: [] as readonly TRow[] };
    },
  };
}

describe("runSaasRlsIsolationSmoke", () => {
  it("rolls back and passes when each tenant context only sees itself", async () => {
    const executor = createExecutor();

    const result = await runSaasRlsIsolationSmoke(executor);

    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.currentUser).toBe("openclaw_tenant");
    expect(result.issues).toEqual([]);
    expect(executor.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "SELECT current_user::text AS current_user, session_user::text AS session_user",
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("INSERT INTO openclaw_saas.tenants"),
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("INSERT INTO openclaw_saas.tenants"),
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("SELECT id::text AS id"),
      "select set_config('app.current_tenant_id', $1, true)",
      expect.stringContaining("SELECT id::text AS id"),
      "ROLLBACK",
    ]);
  });

  it("returns a failed smoke result when the database role bypasses RLS", async () => {
    const executor = createExecutor({ bypassRls: true });

    const result = await runSaasRlsIsolationSmoke(executor);

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "tenant_a_visibility_mismatch",
      "tenant_b_visibility_mismatch",
    ]);
    expect(result.checks.every((check) => check.visibleTenantIds.length === 2)).toBe(true);
    expect(executor.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
