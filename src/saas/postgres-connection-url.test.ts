import { describe, expect, it } from "vitest";
import {
  redactPostgresConnectionUrl,
  resolveSaasPostgresConnection,
} from "./postgres-connection-url.js";

describe("resolveSaasPostgresConnection", () => {
  it("accepts a complete PostgreSQL connection URI without requiring host parts", () => {
    const connection = resolveSaasPostgresConnection({
      DATABASE_URL: "postgresql://tenant_user:secret@db.example.com:5432/openclaw",
    });

    expect(connection).toMatchObject({
      configured: true,
      source: "connection-url",
      connectionUrl: "postgresql://tenant_user:secret@db.example.com:5432/openclaw",
      redactedConnectionUrl: "postgresql://tenant_user:%3Credacted%3E@db.example.com:5432/openclaw",
      issues: [],
    });
  });

  it("builds a PostgreSQL URI from a bare server endpoint", () => {
    const connection = resolveSaasPostgresConnection({
      OPENCLAW_POSTGRES_HOST: "db.example.com:5544",
      OPENCLAW_POSTGRES_DATABASE: "openclaw_saas",
      OPENCLAW_POSTGRES_USER: "tenant_user",
      OPENCLAW_POSTGRES_PASSWORD: "secret value",
      OPENCLAW_POSTGRES_SSLMODE: "verify-full",
    });

    expect(connection).toMatchObject({
      configured: true,
      source: "host-parts",
      connectionUrl:
        "postgresql://tenant_user:secret%20value@db.example.com:5544/openclaw_saas?sslmode=verify-full",
      redactedConnectionUrl:
        "postgresql://tenant_user:%3Credacted%3E@db.example.com:5544/openclaw_saas?sslmode=verify-full",
      issues: [],
    });
  });

  it("extracts host and port from an http server URL without accepting its path", () => {
    expect(
      resolveSaasPostgresConnection({
        OPENCLAW_POSTGRES_HOST: "https://db.example.com:5432",
      }).connectionUrl,
    ).toBe("postgresql://openclaw@db.example.com:5432/openclaw");

    expect(
      resolveSaasPostgresConnection({
        OPENCLAW_POSTGRES_HOST: "https://db.example.com:5432/admin",
      }),
    ).toMatchObject({
      configured: false,
      issues: [expect.objectContaining({ code: "host_invalid", severity: "error" })],
    });
  });

  it("rejects non-PostgreSQL connection URL schemes", () => {
    expect(resolveSaasPostgresConnection({ DATABASE_URL: "https://db.example.com" })).toMatchObject(
      {
        configured: false,
        issues: [
          expect.objectContaining({
            code: "connection_url_scheme_invalid",
            severity: "error",
          }),
        ],
      },
    );
  });

  it("rejects invalid host-part ports and SSL modes", () => {
    expect(
      resolveSaasPostgresConnection({
        OPENCLAW_POSTGRES_HOST: "db.example.com",
        OPENCLAW_POSTGRES_PORT: "70000",
        OPENCLAW_POSTGRES_SSLMODE: "strict",
      }),
    ).toMatchObject({
      configured: false,
      issues: [
        expect.objectContaining({ code: "port_invalid", severity: "error" }),
        expect.objectContaining({ code: "sslmode_invalid", severity: "error" }),
      ],
    });
  });
});

describe("redactPostgresConnectionUrl", () => {
  it("never echoes invalid non-PostgreSQL strings", () => {
    expect(redactPostgresConnectionUrl("https://user:secret@example.com")).toBe(
      "<invalid postgres connection string>",
    );
  });
});
