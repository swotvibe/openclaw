import { beforeAll, describe, expect, it } from "vitest";

let normalizeProviderSpecificConfig: typeof import("./models-config.providers.policy.js").normalizeProviderSpecificConfig;
let resolveProviderConfigApiKeyResolver: typeof import("./models-config.providers.policy.js").resolveProviderConfigApiKeyResolver;
let applyNativeStreamingUsageCompat: typeof import("./models-config.providers.policy.js").applyNativeStreamingUsageCompat;

beforeAll(async () => {
  ({
    normalizeProviderSpecificConfig,
    resolveProviderConfigApiKeyResolver,
    applyNativeStreamingUsageCompat,
  } = await import("./models-config.providers.policy.js"));
});

describe("models-config.providers.policy", () => {
  it("resolves config apiKey markers through provider plugin hooks", async () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;
    const resolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");

    expect(resolver).toBeTypeOf("function");
    expect(resolver?.(env)).toBe("AWS_PROFILE");
  });

  it("resolves anthropic-vertex ADC markers through provider plugin hooks", async () => {
    const resolver = resolveProviderConfigApiKeyResolver("anthropic-vertex");

    expect(resolver).toBeTypeOf("function");
    expect(
      resolver?.({
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("gcp-vertex-credentials");
  });

  it("normalizes Google provider config through provider plugin hooks", async () => {
    expect(
      normalizeProviderSpecificConfig("google", {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        models: [],
      }),
    ).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming usage compat – URL-based fallback for custom provider keys
// ---------------------------------------------------------------------------

function stubProvider(baseUrl: string) {
  return {
    baseUrl,
    api: "openai-completions" as const,
    models: [
      {
        id: "test-model",
        name: "Test",
        reasoning: false,
        input: ["text"] as string[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 4096,
      },
    ],
  };
}

function allModelsStreamingUsage(
  providers: Record<
    string,
    { models?: Array<{ compat?: { supportsUsageInStreaming?: boolean } }> }
  >,
  key: string,
): boolean {
  return providers[key]?.models?.every((m) => m.compat?.supportsUsageInStreaming === true) ?? false;
}

function noModelStreamingUsage(
  providers: Record<
    string,
    { models?: Array<{ compat?: { supportsUsageInStreaming?: boolean } }> }
  >,
  key: string,
): boolean {
  return !providers[key]?.models?.some((m) => m.compat?.supportsUsageInStreaming === true);
}

describe("applyNativeStreamingUsageCompat – DashScope URL-based fallback", () => {
  it("enables streaming usage for DashScope compatible-mode URL under custom provider key", () => {
    const result = applyNativeStreamingUsageCompat({
      dashscope: stubProvider("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    });
    expect(allModelsStreamingUsage(result, "dashscope")).toBe(true);
  });

  it("enables streaming usage for dashscope-intl URL under arbitrary provider key", () => {
    const result = applyNativeStreamingUsageCompat({
      qwen: stubProvider("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    });
    expect(allModelsStreamingUsage(result, "qwen")).toBe(true);
  });

  it("enables streaming usage for coding.dashscope URL under arbitrary provider key", () => {
    const result = applyNativeStreamingUsageCompat({
      alibaba: stubProvider("https://coding.dashscope.aliyuncs.com/v1"),
    });
    expect(allModelsStreamingUsage(result, "alibaba")).toBe(true);
  });

  it("enables streaming usage for coding-intl.dashscope URL under arbitrary provider key", () => {
    const result = applyNativeStreamingUsageCompat({
      intl: stubProvider("https://coding-intl.dashscope.aliyuncs.com/v1"),
    });
    expect(allModelsStreamingUsage(result, "intl")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – URL normalization edge cases", () => {
  it("matches DashScope URL with trailing slash", () => {
    const result = applyNativeStreamingUsageCompat({
      ds: stubProvider("https://dashscope.aliyuncs.com/compatible-mode/v1/"),
    });
    expect(allModelsStreamingUsage(result, "ds")).toBe(true);
  });

  it("matches DashScope URL with mixed case", () => {
    const result = applyNativeStreamingUsageCompat({
      ds: stubProvider("https://DashScope.Aliyuncs.COM/compatible-mode/v1"),
    });
    expect(allModelsStreamingUsage(result, "ds")).toBe(true);
  });

  it("matches DashScope URL with query string", () => {
    const result = applyNativeStreamingUsageCompat({
      ds: stubProvider("https://dashscope.aliyuncs.com/compatible-mode/v1?foo=bar"),
    });
    expect(allModelsStreamingUsage(result, "ds")).toBe(true);
  });

  it("matches DashScope URL with fragment", () => {
    const result = applyNativeStreamingUsageCompat({
      ds: stubProvider("https://dashscope.aliyuncs.com/compatible-mode/v1#section"),
    });
    expect(allModelsStreamingUsage(result, "ds")).toBe(true);
  });

  it("matches Moonshot URL with trailing slash and mixed case", () => {
    const result = applyNativeStreamingUsageCompat({
      kimi: stubProvider("https://API.Moonshot.AI/v1/"),
    });
    expect(allModelsStreamingUsage(result, "kimi")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – negative cases", () => {
  it("does not enable streaming usage for a similar-but-different DashScope subdomain", () => {
    const result = applyNativeStreamingUsageCompat({
      fake: stubProvider("https://fake-dashscope.aliyuncs.com/compatible-mode/v1"),
    });
    expect(noModelStreamingUsage(result, "fake")).toBe(true);
  });

  it("does not enable streaming usage for a DashScope URL with wrong path", () => {
    const result = applyNativeStreamingUsageCompat({
      ds: stubProvider("https://dashscope.aliyuncs.com/v1"),
    });
    expect(noModelStreamingUsage(result, "ds")).toBe(true);
  });

  it("does not affect api.openai.com providers", () => {
    const result = applyNativeStreamingUsageCompat({
      openai: stubProvider("https://api.openai.com/v1"),
    });
    expect(noModelStreamingUsage(result, "openai")).toBe(true);
  });

  it("does not enable streaming usage for generic OpenAI-compatible providers", () => {
    const result = applyNativeStreamingUsageCompat({
      custom: stubProvider("https://my-llm-proxy.example.com/v1"),
    });
    expect(noModelStreamingUsage(result, "custom")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – Moonshot custom provider key", () => {
  it("enables streaming usage for moonshot.ai URL under a custom provider key", () => {
    const result = applyNativeStreamingUsageCompat({
      kimi: stubProvider("https://api.moonshot.ai/v1"),
    });
    expect(allModelsStreamingUsage(result, "kimi")).toBe(true);
  });

  it("enables streaming usage for moonshot.cn URL under a custom provider key", () => {
    const result = applyNativeStreamingUsageCompat({
      "kimi-cn": stubProvider("https://api.moonshot.cn/v1"),
    });
    expect(allModelsStreamingUsage(result, "kimi-cn")).toBe(true);
  });

  it("does not enable streaming usage for a Moonshot proxy URL", () => {
    const result = applyNativeStreamingUsageCompat({
      kimi: stubProvider("https://moonshot-proxy.example.com/v1"),
    });
    expect(noModelStreamingUsage(result, "kimi")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – canonical provider key still works", () => {
  it("enables streaming usage for 'modelstudio' key via plugin hook", () => {
    const result = applyNativeStreamingUsageCompat({
      modelstudio: stubProvider("https://coding-intl.dashscope.aliyuncs.com/v1"),
    });
    expect(allModelsStreamingUsage(result, "modelstudio")).toBe(true);
  });

  it("enables streaming usage for 'moonshot' key via plugin hook", () => {
    const result = applyNativeStreamingUsageCompat({
      moonshot: stubProvider("https://api.moonshot.ai/v1"),
    });
    expect(allModelsStreamingUsage(result, "moonshot")).toBe(true);
  });
});
