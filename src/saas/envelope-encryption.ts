import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const SAAS_SECRET_ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES = 12;
export const SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES = 16;
export const SAAS_SECRET_DEK_LENGTH_BYTES = 32;
export const SAAS_LOCAL_KMS_HKDF_DIGEST = "sha256";
export const SAAS_LOCAL_KMS_DEFAULT_SALT = "openclaw-saas-local-kms-v1";
export const SAAS_LOCAL_KMS_DEFAULT_INFO = "openclaw-saas-secret-kek-v1";

export type SaasSecretBytes = string | Buffer;

export type SaasEncryptedSecretPayload = {
  algorithm: typeof SAAS_SECRET_ENCRYPTION_ALGORITHM;
  dekVersion: number;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
};

export type SaasLocalKekDerivationInput = {
  masterKey: string | Buffer;
  salt?: string | Buffer;
  info?: string | Buffer;
};

type RandomBytesFn = (size: number) => Buffer;

export class SaasEnvelopeEncryptionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaasEnvelopeEncryptionError";
  }
}

export class SaasLocalKmsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasLocalKmsConfigurationError";
  }
}

function toBuffer(value: SaasSecretBytes): Buffer {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
}

function assertSaasDekVersion(dekVersion: number): void {
  if (!Number.isInteger(dekVersion) || dekVersion <= 0) {
    throw new SaasEnvelopeEncryptionError("SaaS secret DEK version must be a positive integer.");
  }
}

export function assertSaasAes256GcmKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== SAAS_SECRET_DEK_LENGTH_BYTES) {
    throw new SaasEnvelopeEncryptionError("SaaS AES-256-GCM keys must be exactly 32 bytes.");
  }
}

function assertSaasEncryptedSecretPayload(payload: SaasEncryptedSecretPayload): void {
  if (payload.algorithm !== SAAS_SECRET_ENCRYPTION_ALGORITHM) {
    throw new SaasEnvelopeEncryptionError(
      `Unsupported SaaS secret encryption algorithm: ${payload.algorithm}.`,
    );
  }
  assertSaasDekVersion(payload.dekVersion);
  if (
    !Buffer.isBuffer(payload.iv) ||
    payload.iv.length !== SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES
  ) {
    throw new SaasEnvelopeEncryptionError("SaaS encrypted secret payload has an invalid IV.");
  }
  if (
    !Buffer.isBuffer(payload.authTag) ||
    payload.authTag.length !== SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES
  ) {
    throw new SaasEnvelopeEncryptionError("SaaS encrypted secret payload has an invalid auth tag.");
  }
  if (!Buffer.isBuffer(payload.ciphertext)) {
    throw new SaasEnvelopeEncryptionError("SaaS encrypted secret payload has invalid ciphertext.");
  }
}

export function generateSaasTenantDek(randomBytesFn: RandomBytesFn = randomBytes): Buffer {
  const dek = randomBytesFn(SAAS_SECRET_DEK_LENGTH_BYTES);
  assertSaasAes256GcmKey(dek);
  return Buffer.from(dek);
}

export function encryptSaasSecretValue(
  plaintext: SaasSecretBytes,
  dek: Buffer,
  dekVersion: number,
  associatedData?: SaasSecretBytes,
  randomBytesFn: RandomBytesFn = randomBytes,
): SaasEncryptedSecretPayload {
  assertSaasAes256GcmKey(dek);
  assertSaasDekVersion(dekVersion);

  const iv = randomBytesFn(SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES);
  if (!Buffer.isBuffer(iv) || iv.length !== SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES) {
    throw new SaasEnvelopeEncryptionError("SaaS secret IV generator returned invalid bytes.");
  }

  const cipher = createCipheriv(SAAS_SECRET_ENCRYPTION_ALGORITHM, dek, iv, {
    authTagLength: SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES,
  });
  if (associatedData !== undefined) {
    cipher.setAAD(toBuffer(associatedData));
  }

  const ciphertext = Buffer.concat([cipher.update(toBuffer(plaintext)), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: SAAS_SECRET_ENCRYPTION_ALGORITHM,
    dekVersion,
    iv: Buffer.from(iv),
    authTag: Buffer.from(authTag),
    ciphertext,
  };
}

export function decryptSaasSecretValue(
  payload: SaasEncryptedSecretPayload,
  dek: Buffer,
  associatedData?: SaasSecretBytes,
): Buffer {
  assertSaasAes256GcmKey(dek);
  assertSaasEncryptedSecretPayload(payload);

  try {
    const decipher = createDecipheriv(SAAS_SECRET_ENCRYPTION_ALGORITHM, dek, payload.iv, {
      authTagLength: SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES,
    });
    if (associatedData !== undefined) {
      decipher.setAAD(toBuffer(associatedData));
    }
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  } catch (error) {
    throw new SaasEnvelopeEncryptionError("Failed to decrypt SaaS secret payload.", error);
  }
}

export function decryptSaasSecretUtf8(
  payload: SaasEncryptedSecretPayload,
  dek: Buffer,
  associatedData?: SaasSecretBytes,
): string {
  return decryptSaasSecretValue(payload, dek, associatedData).toString("utf8");
}

export function packSaasEncryptedSecretPayload(payload: SaasEncryptedSecretPayload): Buffer {
  assertSaasEncryptedSecretPayload(payload);
  return Buffer.concat([payload.iv, payload.authTag, payload.ciphertext]);
}

export function unpackSaasEncryptedSecretPayload(
  packed: Buffer,
  dekVersion: number,
): SaasEncryptedSecretPayload {
  assertSaasDekVersion(dekVersion);
  if (
    !Buffer.isBuffer(packed) ||
    packed.length <
      SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES + SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES
  ) {
    throw new SaasEnvelopeEncryptionError("Packed SaaS encrypted secret payload is too short.");
  }

  const authTagStart = SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES;
  const ciphertextStart = authTagStart + SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES;
  return {
    algorithm: SAAS_SECRET_ENCRYPTION_ALGORITHM,
    dekVersion,
    iv: Buffer.from(packed.subarray(0, authTagStart)),
    authTag: Buffer.from(packed.subarray(authTagStart, ciphertextStart)),
    ciphertext: Buffer.from(packed.subarray(ciphertextStart)),
  };
}

function decodePrefixedSecretBytes(value: string): Buffer {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(":");
  const prefix = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).toLowerCase() : "";
  const encoded = separatorIndex > 0 ? trimmed.slice(separatorIndex + 1) : trimmed;

  if (prefix === "hex") {
    if (encoded.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(encoded)) {
      throw new SaasLocalKmsConfigurationError("OPENCLAW_MASTER_KEY has invalid hex encoding.");
    }
    return Buffer.from(encoded, "hex");
  }

  if (prefix === "base64" || prefix === "base64url") {
    const valid =
      prefix === "base64"
        ? /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        : /^[A-Za-z0-9_-]*={0,2}$/.test(encoded);
    if (!valid || encoded.length % 4 === 1) {
      throw new SaasLocalKmsConfigurationError(
        `OPENCLAW_MASTER_KEY has invalid ${prefix} encoding.`,
      );
    }
    return Buffer.from(encoded, prefix);
  }

  return Buffer.from(trimmed, "utf8");
}

export function decodeSaasLocalMasterKey(masterKey: string): Buffer {
  const decoded = decodePrefixedSecretBytes(masterKey);
  if (decoded.length < SAAS_SECRET_DEK_LENGTH_BYTES) {
    throw new SaasLocalKmsConfigurationError(
      "OPENCLAW_MASTER_KEY must decode to at least 32 bytes.",
    );
  }
  return decoded;
}

export function deriveSaasLocalKek(input: SaasLocalKekDerivationInput): Buffer {
  const masterKey =
    typeof input.masterKey === "string"
      ? decodeSaasLocalMasterKey(input.masterKey)
      : Buffer.from(input.masterKey);
  if (masterKey.length < SAAS_SECRET_DEK_LENGTH_BYTES) {
    throw new SaasLocalKmsConfigurationError(
      "OPENCLAW_MASTER_KEY must decode to at least 32 bytes.",
    );
  }

  const salt =
    input.salt === undefined
      ? Buffer.from(SAAS_LOCAL_KMS_DEFAULT_SALT, "utf8")
      : toBuffer(input.salt);
  const info =
    input.info === undefined
      ? Buffer.from(SAAS_LOCAL_KMS_DEFAULT_INFO, "utf8")
      : toBuffer(input.info);
  return Buffer.from(
    hkdfSync(SAAS_LOCAL_KMS_HKDF_DIGEST, masterKey, salt, info, SAAS_SECRET_DEK_LENGTH_BYTES),
  );
}
