import { describe, expect, it } from "vitest";
import {
  SAAS_SECRET_DEK_LENGTH_BYTES,
  SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES,
  SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES,
  SaasEnvelopeEncryptionError,
  SaasLocalKmsConfigurationError,
  decodeSaasLocalMasterKey,
  decryptSaasSecretUtf8,
  decryptSaasSecretValue,
  deriveSaasLocalKek,
  encryptSaasSecretValue,
  generateSaasTenantDek,
  packSaasEncryptedSecretPayload,
  unpackSaasEncryptedSecretPayload,
} from "./envelope-encryption.js";

const TENANT_AAD = "tenant:550e8400-e29b-41d4-a716-446655440000:openai_api_key";
const KEY = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 1);
const OTHER_KEY = Buffer.alloc(SAAS_SECRET_DEK_LENGTH_BYTES, 2);
const IV = Buffer.alloc(SAAS_SECRET_ENCRYPTION_IV_LENGTH_BYTES, 3);

describe("SaaS envelope encryption", () => {
  it("encrypts and decrypts UTF-8 secrets with authenticated associated data", () => {
    const payload = encryptSaasSecretValue("sk-test-secret", KEY, 1, TENANT_AAD, () =>
      Buffer.from(IV),
    );

    expect(payload.iv).toEqual(IV);
    expect(payload.authTag).toHaveLength(SAAS_SECRET_ENCRYPTION_AUTH_TAG_LENGTH_BYTES);
    expect(payload.ciphertext.toString("utf8")).not.toContain("sk-test-secret");
    expect(decryptSaasSecretUtf8(payload, KEY, TENANT_AAD)).toBe("sk-test-secret");
  });

  it("round-trips binary payloads and the packed BYTEA format", () => {
    const plaintext = Buffer.from([0, 1, 2, 3, 255]);
    const payload = encryptSaasSecretValue(plaintext, KEY, 7, undefined, () => Buffer.from(IV));
    const packed = packSaasEncryptedSecretPayload(payload);
    const unpacked = unpackSaasEncryptedSecretPayload(packed, 7);

    expect(unpacked).toEqual(payload);
    expect(decryptSaasSecretValue(unpacked, KEY)).toEqual(plaintext);
  });

  it("fails authentication when the key, tag, or associated data changes", () => {
    const payload = encryptSaasSecretValue("secret", KEY, 1, TENANT_AAD, () => Buffer.from(IV));
    const tampered = {
      ...payload,
      authTag: Buffer.from(payload.authTag),
    };
    tampered.authTag[0] ^= 1;

    expect(() => decryptSaasSecretUtf8(payload, OTHER_KEY, TENANT_AAD)).toThrow(
      SaasEnvelopeEncryptionError,
    );
    expect(() => decryptSaasSecretUtf8(payload, KEY, "tenant:other")).toThrow(
      SaasEnvelopeEncryptionError,
    );
    expect(() => decryptSaasSecretUtf8(tampered, KEY, TENANT_AAD)).toThrow(
      SaasEnvelopeEncryptionError,
    );
  });

  it("rejects invalid key lengths and malformed packed values", () => {
    expect(() => encryptSaasSecretValue("secret", Buffer.alloc(31), 1)).toThrow(
      SaasEnvelopeEncryptionError,
    );
    expect(() => unpackSaasEncryptedSecretPayload(Buffer.alloc(10), 1)).toThrow(
      SaasEnvelopeEncryptionError,
    );
  });

  it("generates 256-bit tenant DEKs", () => {
    expect(generateSaasTenantDek()).toHaveLength(SAAS_SECRET_DEK_LENGTH_BYTES);
  });
});

describe("SaaS local KMS derivation", () => {
  it("derives deterministic 256-bit local KEKs from a high-entropy master key", () => {
    const masterKey = `hex:${Buffer.alloc(32, 4).toString("hex")}`;
    const first = deriveSaasLocalKek({ masterKey });
    const second = deriveSaasLocalKek({ masterKey });
    const differentInfo = deriveSaasLocalKek({ masterKey, info: "other-purpose" });

    expect(first).toHaveLength(SAAS_SECRET_DEK_LENGTH_BYTES);
    expect(first).toEqual(second);
    expect(first).not.toEqual(differentInfo);
  });

  it("decodes supported master key encodings", () => {
    const raw = Buffer.alloc(32, 5);

    expect(decodeSaasLocalMasterKey(`hex:${raw.toString("hex")}`)).toEqual(raw);
    expect(decodeSaasLocalMasterKey(`base64:${raw.toString("base64")}`)).toEqual(raw);
    expect(decodeSaasLocalMasterKey(`base64url:${raw.toString("base64url")}`)).toEqual(raw);
  });

  it("rejects short or malformed local master keys", () => {
    expect(() => decodeSaasLocalMasterKey("too-short")).toThrow(SaasLocalKmsConfigurationError);
    expect(() => decodeSaasLocalMasterKey("hex:not-hex")).toThrow(SaasLocalKmsConfigurationError);
  });
});
