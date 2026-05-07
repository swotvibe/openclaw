---
summary: "CLI reference for `openclaw saas` (SaaS PostgreSQL readiness and migrations)"
read_when:
  - You are validating SaaS PostgreSQL readiness
  - You need to preview or apply SaaS database migrations
  - You are running OpenClaw with a managed PostgreSQL database
title: "SaaS"
---

# `openclaw saas`

Inspect SaaS database readiness and apply the PostgreSQL schema migrations used
by the SaaS data-isolation layer.

The command never prints the raw PostgreSQL connection string. Human and JSON
output use redacted connection URLs only.

The CLI loads environment variables from the current working directory `.env`
file and the standard OpenClaw state `.env` fallback before evaluating SaaS
readiness.

## Status

```bash
openclaw saas status
openclaw saas status --live
openclaw saas status --json
```

`status` checks local environment configuration by default. Use `--live` to
connect to PostgreSQL and read the migration ledger without creating or changing
tables.

The status can be:

- `disabled`: `OPENCLAW_SAAS_MODE` is not enabled.
- `blocked`: SaaS mode is enabled, but required database configuration is
  missing or invalid.
- `needs_migration`: PostgreSQL is configured and the schema has pending
  migrations.
- `ready`: SaaS mode, database configuration, and schema migrations are current.

## Migrate

```bash
openclaw saas migrate
openclaw saas migrate --yes
openclaw saas migrate --json
```

`migrate` is a dry run unless `--yes` is provided. The dry run reads the
PostgreSQL migration ledger and reports pending migrations without writes.

`migrate --yes` applies pending migrations inside the migration runner. It
requires `OPENCLAW_SAAS_MODE=1` and a valid tenant PostgreSQL connection. The
runner records applied migration IDs and checksums in
`openclaw_saas.schema_migrations`.

## RLS Check

```bash
openclaw saas rls-check
openclaw saas rls-check --json
```

`rls-check` runs a live PostgreSQL row-level security smoke test after verifying
that migrations are current. It creates two temporary smoke tenants inside one
transaction, switches `app.current_tenant_id` between them, verifies that each
tenant context sees only its own row, and then rolls the transaction back.

The check fails when the connected database role bypasses RLS, when RLS policies
are missing or disabled, or when pending migrations mean the schema is not ready.

## Tenant Create

```bash
openclaw saas tenant create --slug acme --name "Acme Inc" --owner-user-id owner@example.com
openclaw saas tenant create --slug acme --name "Acme Inc" --owner-user-id owner@example.com --agent-id default
openclaw saas tenant create --slug acme --name "Acme Inc" --owner-user-id owner@example.com --yes
openclaw saas tenant create --slug acme --name "Acme Inc" --owner-user-id owner@example.com --json
```

`tenant create` is a dry run unless `--yes` is provided. It validates and
normalizes the tenant slug, generates a tenant UUID when `--tenant-id` is not
provided, and shows the exact provisioning plan.

`tenant create --yes` first checks live PostgreSQL readiness. It only writes
when migrations are current. The provisioning transaction sets the
transaction-local tenant context, inserts the tenant, inserts the initial owner
membership, creates the initial encrypted tenant DEK, and optionally creates a
default agent when `--agent-id` is set.

The current KMS implementation supports the local provider only:

```bash
OPENCLAW_KMS_PROVIDER=local
OPENCLAW_MASTER_KEY=hex:REDACTED_32_BYTE_OR_LONGER_KEY
```

`tenant create --yes` fails without `OPENCLAW_MASTER_KEY` while local KMS is in
use. Do not reuse database passwords or API keys as the master key.

If you need a stable UUID across dry run and apply, pass `--tenant-id <uuid>`.

## Environment

The tenant database can be configured with either a full URI or split host
settings:

```bash
OPENCLAW_SAAS_MODE=1
DATABASE_URL=postgresql://openclaw:REDACTED_PASSWORD@postgres:5432/openclaw
```

or:

```bash
OPENCLAW_SAAS_MODE=1
OPENCLAW_POSTGRES_HOST=postgres
OPENCLAW_POSTGRES_PORT=5432
OPENCLAW_POSTGRES_DATABASE=openclaw
OPENCLAW_POSTGRES_USER=openclaw
OPENCLAW_POSTGRES_PASSWORD=...
OPENCLAW_POSTGRES_SSLMODE=require
```

For cross-tenant service work, configure a separate service role with
`OPENCLAW_SERVICE_DATABASE_URL` or the `OPENCLAW_SERVICE_POSTGRES_*` variables.
Do not reuse the tenant request role for cross-tenant maintenance.

## Related

- [CLI reference](/cli)
- [Docker install](/install/docker)
