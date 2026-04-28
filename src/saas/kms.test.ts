import { describe, expect, it } from "vitest";
import {
  SaasKmsConfigurationError,
  SaasKmsError,
  createLocalSaasKmsProvider,
  resolveConfiguredSaasKmsProvider,
} from "./kms.js";

const MASTER_KEY = `hex:${Buffer.alloc(32, 7).toString("hex")}`;
const AAD = "openclaw_saas:tenant_dek:550e8400-e29b-41d4-a716-446655440000:1";

describe("LocalSaasKmsProvider", () => {
  it("encrypts and decrypts bytes with authenticated associated data", async () => {
    const provider = createLocalSaasKmsProvider({
      masterKey: MASTER_KEY,
      keyId: "local:test",
    });
    const plaintext = Buffer.from("tenant-dek-material");

    const encrypted = await provider.encrypt(plaintext, AAD);

    expect(encrypted.keyId).toBe("local:test");
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("tenant-dek-material");
    await expect(provider.decrypt(encrypted, AAD)).resolves.toEqual(plaintext);
  });

  it("fails decryption for wrong AAD or key id", async () => {
    const provider = createLocalSaasKmsProvider({ masterKey: MASTER_KEY, keyId: "local:test" });
    const encrypted = await provider.encrypt(Buffer.from("secret"), AAD);

    await expect(provider.decrypt(encrypted, "wrong-aad")).rejects.toThrow();
    await expect(
      provider.decrypt(
        {
          ...encrypted,
          keyId: "local:other",
        },
        AAD,
      ),
    ).rejects.toThrow(SaasKmsError);
  });
});

describe("resolveConfiguredSaasKmsProvider", () => {
  it("creates a local KMS provider from env", async () => {
    const provider = resolveConfiguredSaasKmsProvider({
      OPENCLAW_KMS_PROVIDER: "local",
      OPENCLAW_MASTER_KEY: MASTER_KEY,
      OPENCLAW_KMS_KEY_ID: "local:env",
    });

    const encrypted = await provider.encrypt(Buffer.from("secret"), AAD);

    expect(provider.keyId()).toBe("local:env");
    await expect(provider.decrypt(encrypted, AAD)).resolves.toEqual(Buffer.from("secret"));
  });

  it("rejects missing local master keys and unimplemented providers", () => {
    expect(() => resolveConfiguredSaasKmsProvider({ OPENCLAW_KMS_PROVIDER: "local" })).toThrow(
      SaasKmsConfigurationError,
    );
    expect(() =>
      resolveConfiguredSaasKmsProvider({
        OPENCLAW_KMS_PROVIDER: "aws",
        OPENCLAW_MASTER_KEY: MASTER_KEY,
      }),
    ).toThrow(SaasKmsConfigurationError);
  });
});
