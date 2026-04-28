export const POSTGRES_TENANT_SETTING_NAME = "app.current_tenant_id";

declare const tenantIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };

export type TenantContextQuery = {
  text: string;
  values: readonly [string];
};

export type TenantContextTransaction = {
  setTenantContext: (tenantId: TenantId) => Promise<void>;
};

export type TenantContextDatabase<TTransaction extends TenantContextTransaction> = {
  transaction: <T>(callback: (tx: TTransaction) => Promise<T>) => Promise<T>;
};

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`Invalid tenant id: ${value}`);
    this.name = "InvalidTenantIdError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseTenantId(value: string): TenantId {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new InvalidTenantIdError(value);
  }
  return normalized as TenantId;
}

export function createPostgresSetTenantContextQuery(value: string): TenantContextQuery {
  const tenantId = parseTenantId(value);
  return {
    text: `select set_config('${POSTGRES_TENANT_SETTING_NAME}', $1, true)`,
    values: [tenantId],
  };
}

export async function withTenantContext<TTransaction extends TenantContextTransaction, TResult>(
  db: TenantContextDatabase<TTransaction>,
  tenantId: string,
  callback: (tx: TTransaction, tenantId: TenantId) => Promise<TResult>,
): Promise<TResult> {
  const parsedTenantId = parseTenantId(tenantId);
  return await db.transaction(async (tx) => {
    await tx.setTenantContext(parsedTenantId);
    return await callback(tx, parsedTenantId);
  });
}
