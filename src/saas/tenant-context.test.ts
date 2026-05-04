import { describe, expect, it } from "vitest";
import {
  InvalidTenantIdError,
  createPostgresSetTenantContextQuery,
  parseTenantId,
  withTenantContext,
} from "./tenant-context.js";

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("parseTenantId", () => {
  it("normalizes valid UUID tenant ids", () => {
    expect(parseTenantId(" 550E8400-E29B-41D4-A716-446655440000 ")).toBe(TENANT_ID);
  });

  it("rejects invalid tenant ids before opening a transaction", () => {
    expect(() => parseTenantId("tenant-one")).toThrow(InvalidTenantIdError);
  });
});

describe("createPostgresSetTenantContextQuery", () => {
  it("uses a parameterized transaction-local PostgreSQL setting", () => {
    expect(createPostgresSetTenantContextQuery(TENANT_ID)).toEqual({
      text: "select set_config('app.current_tenant_id', $1, true)",
      values: [TENANT_ID],
    });
  });

  it("rejects input instead of interpolating it into SQL", () => {
    expect(() => createPostgresSetTenantContextQuery(`${TENANT_ID}'; select 1; --`)).toThrow(
      InvalidTenantIdError,
    );
  });
});

describe("withTenantContext", () => {
  it("sets tenant context before running the callback in the transaction", async () => {
    const calls: string[] = [];
    const db = {
      async transaction<T>(
        callback: (tx: { setTenantContext: (id: string) => Promise<void> }) => Promise<T>,
      ) {
        calls.push("transaction:start");
        const result = await callback({
          async setTenantContext(id: string) {
            calls.push(`tenant:${id}`);
          },
        });
        calls.push("transaction:end");
        return result;
      },
    };

    const result = await withTenantContext(db, TENANT_ID, async (_tx, tenantId) => {
      calls.push(`callback:${tenantId}`);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toEqual([
      "transaction:start",
      `tenant:${TENANT_ID}`,
      `callback:${TENANT_ID}`,
      "transaction:end",
    ]);
  });

  it("does not open a transaction for invalid tenant ids", async () => {
    let opened = false;
    const db = {
      async transaction<T>(
        _callback: (tx: { setTenantContext: (id: string) => Promise<void> }) => Promise<T>,
      ) {
        opened = true;
        throw new Error("should not open");
      },
    };

    await expect(withTenantContext(db, "bad-id", async () => "never")).rejects.toThrow(
      InvalidTenantIdError,
    );
    expect(opened).toBe(false);
  });
});
