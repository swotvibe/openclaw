import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createSaasPostgresPgExecutor, withSaasPostgresPgClient } from "./postgres-pg-executor.js";

function createFakeClient() {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  let released = false;
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      calls.push(params ? { sql, params } : { sql });
      return { rows: [{ ok: true }] };
    },
    release() {
      released = true;
    },
  } as unknown as PoolClient;

  return {
    client,
    calls,
    get released() {
      return released;
    },
  };
}

describe("createSaasPostgresPgExecutor", () => {
  it("adapts a node-postgres client to the SaaS query executor interface", async () => {
    const fake = createFakeClient();
    const executor = createSaasPostgresPgExecutor(fake.client);

    await expect(executor.query("select $1::text as value", ["hello"])).resolves.toEqual({
      rows: [{ ok: true }],
    });
    expect(fake.calls).toEqual([{ sql: "select $1::text as value", params: ["hello"] }]);
  });
});

describe("withSaasPostgresPgClient", () => {
  it("uses one checked-out client and releases it after success", async () => {
    const fake = createFakeClient();
    const pool = {
      async connect() {
        return fake.client;
      },
    } as unknown as Pool;

    const result = await withSaasPostgresPgClient(pool, async (executor, client) => {
      expect(client).toBe(fake.client);
      await executor.query("select 1");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(fake.released).toBe(true);
  });

  it("releases the checked-out client after callback failures", async () => {
    const fake = createFakeClient();
    const pool = {
      async connect() {
        return fake.client;
      },
    } as unknown as Pool;

    await expect(
      withSaasPostgresPgClient(pool, async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(fake.released).toBe(true);
  });
});
