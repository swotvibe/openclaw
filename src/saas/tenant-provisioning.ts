import { randomUUID } from "node:crypto";
import { assertSaasAes256GcmKey, generateSaasTenantDek } from "./envelope-encryption.js";
import type { SaasKmsProvider } from "./kms.js";
import type { SaasPostgresQueryExecutor } from "./postgres-migration-runner.js";
import {
  createPostgresSetTenantContextQuery,
  parseTenantId,
  type TenantId,
} from "./tenant-context.js";
import {
  SAAS_INITIAL_TENANT_DEK_VERSION,
  createSaasTenantDekAssociatedData,
  type EncryptedSaasTenantDek,
} from "./tenant-deks.js";

export type SaasTenantProvisioningInput = {
  tenantId?: string;
  slug: string;
  displayName: string;
  ownerUserId: string;
  agentId?: string;
  agentDisplayName?: string;
};

export type SaasTenantProvisioningPlan = {
  tenantId: TenantId;
  slug: string;
  displayName: string;
  ownerUserId: string;
  agent?: {
    agentId: string;
    displayName: string;
  };
};

export type SaasTenantProvisioningResult = SaasTenantProvisioningPlan & {
  created: true;
  initialDek?: {
    version: number;
    keyId: string;
  };
};

export type SaasTenantProvisioningOptions = {
  kmsProvider?: SaasKmsProvider;
  generateDek?: () => Buffer;
};

type TenantProvisioningRow = {
  id: unknown;
  slug: unknown;
  display_name: unknown;
};

export class SaasTenantProvisioningValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "SaasTenantProvisioningValidationError";
  }
}

export class SaasTenantProvisioningConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasTenantProvisioningConflictError";
  }
}

export class SaasTenantProvisioningError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaasTenantProvisioningError";
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function normalizeRequiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new SaasTenantProvisioningValidationError(`${field} is required.`, field);
  }
  if (normalized.length > maxLength) {
    throw new SaasTenantProvisioningValidationError(
      `${field} must be at most ${maxLength} characters.`,
      field,
    );
  }
  return normalized;
}

export function normalizeSaasTenantSlug(value: string): string {
  const slug = normalizeRequiredText(value, "slug", 63).toLowerCase();
  if (slug.length < 3) {
    throw new SaasTenantProvisioningValidationError("slug must be at least 3 characters.", "slug");
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new SaasTenantProvisioningValidationError(
      "slug must start and end with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens.",
      "slug",
    );
  }
  return slug;
}

function normalizeAgentId(value: string): string {
  const agentId = normalizeRequiredText(value, "agentId", 128);
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new SaasTenantProvisioningValidationError(
      "agentId must start with a letter or number and contain only letters, numbers, dots, underscores, colons, or hyphens.",
      "agentId",
    );
  }
  return agentId;
}

export function buildSaasTenantProvisioningPlan(
  input: SaasTenantProvisioningInput,
): SaasTenantProvisioningPlan {
  const tenantId = parseTenantId(input.tenantId ?? randomUUID());
  const slug = normalizeSaasTenantSlug(input.slug);
  const displayName = normalizeRequiredText(input.displayName, "displayName", 200);
  const ownerUserId = normalizeRequiredText(input.ownerUserId, "ownerUserId", 256);
  const rawAgentId = input.agentId?.trim();
  const agentId = rawAgentId ? normalizeAgentId(rawAgentId) : undefined;
  const agentDisplayName = agentId
    ? normalizeRequiredText(input.agentDisplayName ?? "Default Agent", "agentDisplayName", 200)
    : undefined;

  return {
    tenantId,
    slug,
    displayName,
    ownerUserId,
    ...(agentId && agentDisplayName
      ? {
          agent: {
            agentId,
            displayName: agentDisplayName,
          },
        }
      : {}),
  };
}

async function rollbackBestEffort(executor: SaasPostgresQueryExecutor): Promise<void> {
  try {
    await executor.query("ROLLBACK");
  } catch {
    // Preserve the original provisioning failure.
  }
}

function normalizeTenantProvisioningRow(row: TenantProvisioningRow | undefined): {
  id: TenantId;
  slug: string;
  displayName: string;
} {
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.slug !== "string" ||
    typeof row.display_name !== "string"
  ) {
    throw new SaasTenantProvisioningError("Invalid SaaS tenant provisioning result row.");
  }
  return {
    id: parseTenantId(row.id),
    slug: row.slug,
    displayName: row.display_name,
  };
}

async function createInitialTenantDek(
  plan: SaasTenantProvisioningPlan,
  options: SaasTenantProvisioningOptions,
): Promise<EncryptedSaasTenantDek | undefined> {
  if (!options.kmsProvider) {
    return undefined;
  }

  const version = SAAS_INITIAL_TENANT_DEK_VERSION;
  const dek = options.generateDek ? options.generateDek() : generateSaasTenantDek();
  assertSaasAes256GcmKey(dek);
  try {
    const encrypted = await options.kmsProvider.encrypt(
      dek,
      createSaasTenantDekAssociatedData(plan.tenantId, version),
    );
    return {
      version,
      keyId: encrypted.keyId,
      algorithm: encrypted.algorithm,
      encryptedDek: encrypted.ciphertext,
    };
  } finally {
    dek.fill(0);
  }
}

export async function provisionSaasTenant(
  executor: SaasPostgresQueryExecutor,
  input: SaasTenantProvisioningInput,
  options: SaasTenantProvisioningOptions = {},
): Promise<SaasTenantProvisioningResult> {
  const plan = buildSaasTenantProvisioningPlan(input);
  const initialDek = await createInitialTenantDek(plan, options);
  await executor.query("BEGIN");

  try {
    const tenantContext = createPostgresSetTenantContextQuery(plan.tenantId);
    await executor.query(tenantContext.text, tenantContext.values);

    const tenantResult = await executor.query<TenantProvisioningRow>(
      `
INSERT INTO openclaw_saas.tenants (id, slug, display_name, status)
VALUES ($1, $2, $3, 'active')
ON CONFLICT DO NOTHING
RETURNING id, slug, display_name
`.trim(),
      [plan.tenantId, plan.slug, plan.displayName],
    );

    if (tenantResult.rows.length === 0) {
      throw new SaasTenantProvisioningConflictError(
        `A SaaS tenant already exists for id ${plan.tenantId} or slug ${plan.slug}.`,
      );
    }

    const tenant = normalizeTenantProvisioningRow(tenantResult.rows[0]);
    await executor.query(
      `
INSERT INTO openclaw_saas.tenant_users (tenant_id, user_id, role)
VALUES ($1, $2, 'owner')
ON CONFLICT (tenant_id, user_id) DO UPDATE
SET role = 'owner'
`.trim(),
      [tenant.id, plan.ownerUserId],
    );

    if (initialDek) {
      await executor.query(
        `
INSERT INTO openclaw_saas.tenant_deks (
  tenant_id,
  version,
  encrypted_dek,
  kek_id,
  algorithm,
  is_active
)
VALUES ($1, $2, $3, $4, $5, true)
`.trim(),
        [
          tenant.id,
          initialDek.version,
          initialDek.encryptedDek,
          initialDek.keyId,
          initialDek.algorithm,
        ],
      );
    }

    if (plan.agent) {
      await executor.query(
        `
INSERT INTO openclaw_saas.agents (tenant_id, agent_id, display_name, config_json)
VALUES ($1, $2, $3, '{}'::jsonb)
ON CONFLICT (tenant_id, agent_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    updated_at = now()
`.trim(),
        [tenant.id, plan.agent.agentId, plan.agent.displayName],
      );
    }

    await executor.query("COMMIT");
    return {
      ...plan,
      tenantId: tenant.id,
      slug: tenant.slug,
      displayName: tenant.displayName,
      ...(initialDek
        ? {
            initialDek: {
              version: initialDek.version,
              keyId: initialDek.keyId,
            },
          }
        : {}),
      created: true,
    };
  } catch (error) {
    await rollbackBestEffort(executor);
    if (
      error instanceof SaasTenantProvisioningValidationError ||
      error instanceof SaasTenantProvisioningConflictError ||
      error instanceof SaasTenantProvisioningError
    ) {
      throw error;
    }
    throw new SaasTenantProvisioningError("Failed to provision SaaS tenant.", error);
  }
}
