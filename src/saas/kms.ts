import {
  SAAS_SECRET_ENCRYPTION_ALGORITHM,
  decryptSaasSecretValue,
  deriveSaasLocalKek,
  encryptSaasSecretValue,
  packSaasEncryptedSecretPayload,
  unpackSaasEncryptedSecretPayload,
  type SaasSecretBytes,
} from "./envelope-encryption.js";
import type { PackedSaasTenantDekPayload } from "./tenant-deks.js";

export type SaasKmsEncryptedData = {
  keyId: string;
  algorithm: typeof SAAS_SECRET_ENCRYPTION_ALGORITHM;
  ciphertext: Buffer;
};

export type SaasKmsProvider = {
  keyId(): string;
  encrypt(plaintext: Buffer, associatedData?: SaasSecretBytes): Promise<SaasKmsEncryptedData>;
  decrypt(encrypted: SaasKmsEncryptedData, associatedData?: SaasSecretBytes): Promise<Buffer>;
};

export type LocalSaasKmsProviderOptions = {
  masterKey: string | Buffer;
  keyId?: string;
  salt?: string | Buffer;
};

export class SaasKmsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasKmsConfigurationError";
  }
}

export class SaasKmsError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaasKmsError";
  }
}

const LOCAL_KMS_PAYLOAD_VERSION = 1;
const DEFAULT_LOCAL_KMS_KEY_ID = "local:v1";

function normalizeKmsKeyId(keyId: string): string {
  const normalized = keyId.trim();
  if (!normalized) {
    throw new SaasKmsConfigurationError("SaaS KMS key id is required.");
  }
  return normalized;
}

export class LocalSaasKmsProvider implements SaasKmsProvider {
  private readonly kek: Buffer;
  private readonly normalizedKeyId: string;

  constructor(options: LocalSaasKmsProviderOptions) {
    this.normalizedKeyId = normalizeKmsKeyId(options.keyId ?? DEFAULT_LOCAL_KMS_KEY_ID);
    this.kek = deriveSaasLocalKek({
      masterKey: options.masterKey,
      ...(options.salt !== undefined ? { salt: options.salt } : {}),
    });
  }

  keyId(): string {
    return this.normalizedKeyId;
  }

  async encrypt(
    plaintext: Buffer,
    associatedData?: SaasSecretBytes,
  ): Promise<SaasKmsEncryptedData> {
    const payload = encryptSaasSecretValue(
      plaintext,
      this.kek,
      LOCAL_KMS_PAYLOAD_VERSION,
      associatedData,
    );
    return {
      keyId: this.normalizedKeyId,
      algorithm: payload.algorithm,
      ciphertext: packSaasEncryptedSecretPayload(payload),
    };
  }

  async decrypt(
    encrypted: PackedSaasTenantDekPayload,
    associatedData?: SaasSecretBytes,
  ): Promise<Buffer> {
    if (encrypted.keyId !== this.normalizedKeyId) {
      throw new SaasKmsError(`SaaS KMS key id mismatch for ${encrypted.keyId}.`);
    }
    if (encrypted.algorithm !== SAAS_SECRET_ENCRYPTION_ALGORITHM) {
      throw new SaasKmsError(`Unsupported SaaS KMS algorithm: ${encrypted.algorithm}.`);
    }
    const payload = unpackSaasEncryptedSecretPayload(
      encrypted.ciphertext,
      LOCAL_KMS_PAYLOAD_VERSION,
    );
    return decryptSaasSecretValue(payload, this.kek, associatedData);
  }
}

export function createLocalSaasKmsProvider(options: LocalSaasKmsProviderOptions): SaasKmsProvider {
  return new LocalSaasKmsProvider(options);
}

export function resolveConfiguredSaasKmsProvider(
  env: NodeJS.ProcessEnv = process.env,
): SaasKmsProvider {
  const provider = (env.OPENCLAW_KMS_PROVIDER ?? "local").trim().toLowerCase();
  if (provider === "local") {
    const masterKey = env.OPENCLAW_MASTER_KEY;
    if (!masterKey) {
      throw new SaasKmsConfigurationError(
        "OPENCLAW_MASTER_KEY is required when OPENCLAW_KMS_PROVIDER=local.",
      );
    }
    return createLocalSaasKmsProvider({
      masterKey,
      keyId: env.OPENCLAW_KMS_KEY_ID ?? DEFAULT_LOCAL_KMS_KEY_ID,
      ...(env.OPENCLAW_MASTER_KEY_SALT ? { salt: env.OPENCLAW_MASTER_KEY_SALT } : {}),
    });
  }

  if (provider === "aws" || provider === "gcp" || provider === "vault") {
    throw new SaasKmsConfigurationError(
      `OPENCLAW_KMS_PROVIDER=${provider} is planned but not implemented yet.`,
    );
  }

  throw new SaasKmsConfigurationError(`Unsupported OPENCLAW_KMS_PROVIDER: ${provider}.`);
}
