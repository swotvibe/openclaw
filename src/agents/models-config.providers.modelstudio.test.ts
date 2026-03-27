import { describe, expect, it } from "vitest";
import {
  applyNativeStreamingUsageCompat,
  buildModelStudioProvider,
} from "./models-config.providers.js";
import { buildMoonshotProvider } from "./models-config.providers.static.js";

// Helper: check every model in a provider has supportsUsageInStreaming === true.
function allModelsStreamingUsage(
  providers: Record<
    string,
    { models?: Array<{ compat?: { supportsUsageInStreaming?: boolean } }> }
  >,
  key: string,
): boolean {
  return providers[key]?.models?.every((m) => m.compat?.supportsUsageInStreaming === true) ?? false;
}

// Helper: check no model in a provider has supportsUsageInStreaming set to true.
function noModelStreamingUsage(
  providers: Record<
    string,
    { models?: Array<{ compat?: { supportsUsageInStreaming?: boolean } }> }
  >,
  key: string,
): boolean {
  return !providers[key]?.models?.some((m) => m.compat?.supportsUsageInStreaming === true);
}

describe("Model Studio implicit provider", () => {
  it("should opt native Model Studio baseUrls into streaming usage", () => {
    const providers = applyNativeStreamingUsageCompat({
      modelstudio: buildModelStudioProvider(),
    });
    expect(providers?.modelstudio).toBeDefined();
    expect(providers?.modelstudio?.baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
    expect(allModelsStreamingUsage(providers, "modelstudio")).toBe(true);
  });

  it("should keep streaming usage opt-in disabled for custom Model Studio-compatible baseUrls", () => {
    const providers = applyNativeStreamingUsageCompat({
      modelstudio: {
        ...buildModelStudioProvider(),
        baseUrl: "https://proxy.example.com/v1",
      },
    });
    expect(providers?.modelstudio).toBeDefined();
    expect(noModelStreamingUsage(providers, "modelstudio")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – DashScope URL-based detection", () => {
  it("enables streaming usage for DashScope compatible-mode URL under custom provider key", () => {
    const providers = applyNativeStreamingUsageCompat({
      dashscope: {
        ...buildModelStudioProvider(),
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
    });
    expect(allModelsStreamingUsage(providers, "dashscope")).toBe(true);
  });

  it("enables streaming usage for dashscope-intl URL under arbitrary provider key", () => {
    const providers = applyNativeStreamingUsageCompat({
      qwen: {
        ...buildModelStudioProvider(),
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    });
    expect(allModelsStreamingUsage(providers, "qwen")).toBe(true);
  });

  it("enables streaming usage for coding.dashscope URL under arbitrary provider key", () => {
    const providers = applyNativeStreamingUsageCompat({
      alibaba: {
        ...buildModelStudioProvider(),
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      },
    });
    expect(allModelsStreamingUsage(providers, "alibaba")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – URL normalization edge cases", () => {
  it("matches DashScope URL with trailing slash", () => {
    const providers = applyNativeStreamingUsageCompat({
      ds: {
        ...buildModelStudioProvider(),
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
      },
    });
    expect(allModelsStreamingUsage(providers, "ds")).toBe(true);
  });

  it("matches DashScope URL with mixed case", () => {
    const providers = applyNativeStreamingUsageCompat({
      ds: {
        ...buildModelStudioProvider(),
        baseUrl: "https://DashScope.Aliyuncs.com/compatible-mode/v1",
      },
    });
    expect(allModelsStreamingUsage(providers, "ds")).toBe(true);
  });

  it("matches DashScope URL with query string", () => {
    const providers = applyNativeStreamingUsageCompat({
      ds: {
        ...buildModelStudioProvider(),
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1?foo=bar",
      },
    });
    expect(allModelsStreamingUsage(providers, "ds")).toBe(true);
  });

  it("matches DashScope URL with fragment", () => {
    const providers = applyNativeStreamingUsageCompat({
      ds: {
        ...buildModelStudioProvider(),
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1#section",
      },
    });
    expect(allModelsStreamingUsage(providers, "ds")).toBe(true);
  });

  it("matches DashScope URL with trailing slash, query string, and mixed case combined", () => {
    const providers = applyNativeStreamingUsageCompat({
      ds: {
        ...buildModelStudioProvider(),
        baseUrl: "https://DASHSCOPE.aliyuncs.COM/compatible-mode/v1/?key=val#frag",
      },
    });
    expect(allModelsStreamingUsage(providers, "ds")).toBe(true);
  });

  it("matches Moonshot URL with trailing slash and mixed case", () => {
    const providers = applyNativeStreamingUsageCompat({
      kimi: {
        ...buildMoonshotProvider(),
        baseUrl: "https://API.Moonshot.AI/v1/",
      },
    });
    expect(allModelsStreamingUsage(providers, "kimi")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – negative cases", () => {
  it("does not enable streaming usage for a similar-but-different DashScope subdomain", () => {
    const providers = applyNativeStreamingUsageCompat({
      fake: {
        ...buildModelStudioProvider(),
        baseUrl: "https://fake-dashscope.aliyuncs.com/compatible-mode/v1",
      },
    });
    expect(noModelStreamingUsage(providers, "fake")).toBe(true);
  });

  it("does not enable streaming usage for a DashScope URL with wrong path", () => {
    const providers = applyNativeStreamingUsageCompat({
      ds: {
        ...buildModelStudioProvider(),
        baseUrl: "https://dashscope.aliyuncs.com/v1",
      },
    });
    expect(noModelStreamingUsage(providers, "ds")).toBe(true);
  });

  it("does not affect api.openai.com providers", () => {
    const providers = applyNativeStreamingUsageCompat({
      openai: {
        ...buildModelStudioProvider(),
        baseUrl: "https://api.openai.com/v1",
      },
    });
    expect(noModelStreamingUsage(providers, "openai")).toBe(true);
  });

  it("does not enable streaming usage for generic OpenAI-compatible providers", () => {
    const providers = applyNativeStreamingUsageCompat({
      custom: {
        ...buildModelStudioProvider(),
        baseUrl: "https://my-llm-proxy.example.com/v1",
      },
    });
    expect(noModelStreamingUsage(providers, "custom")).toBe(true);
  });

  it("does not enable streaming usage for a proxy even if provider key is 'modelstudio'", () => {
    const providers = applyNativeStreamingUsageCompat({
      modelstudio: {
        ...buildModelStudioProvider(),
        baseUrl: "https://proxy.example.com/v1",
      },
    });
    expect(noModelStreamingUsage(providers, "modelstudio")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – Moonshot custom provider key", () => {
  it("enables streaming usage for moonshot.ai URL under a custom provider key", () => {
    const providers = applyNativeStreamingUsageCompat({
      kimi: {
        ...buildMoonshotProvider(),
        baseUrl: "https://api.moonshot.ai/v1",
      },
    });
    expect(allModelsStreamingUsage(providers, "kimi")).toBe(true);
  });

  it("enables streaming usage for moonshot.cn URL under a custom provider key", () => {
    const providers = applyNativeStreamingUsageCompat({
      "kimi-cn": {
        ...buildMoonshotProvider(),
        baseUrl: "https://api.moonshot.cn/v1",
      },
    });
    expect(allModelsStreamingUsage(providers, "kimi-cn")).toBe(true);
  });

  it("does not enable streaming usage for a Moonshot proxy URL", () => {
    const providers = applyNativeStreamingUsageCompat({
      kimi: {
        ...buildMoonshotProvider(),
        baseUrl: "https://moonshot-proxy.example.com/v1",
      },
    });
    expect(noModelStreamingUsage(providers, "kimi")).toBe(true);
  });
});

describe("applyNativeStreamingUsageCompat – empty baseUrl providerKey fallback", () => {
  it("enables streaming usage for 'modelstudio' key with no baseUrl", () => {
    const provider = buildModelStudioProvider();
    delete (provider as { baseUrl?: string }).baseUrl;
    const providers = applyNativeStreamingUsageCompat({ modelstudio: provider });
    expect(allModelsStreamingUsage(providers, "modelstudio")).toBe(true);
  });

  it("enables streaming usage for 'moonshot' key with no baseUrl", () => {
    const provider = buildMoonshotProvider();
    delete (provider as { baseUrl?: string }).baseUrl;
    const providers = applyNativeStreamingUsageCompat({ moonshot: provider });
    expect(allModelsStreamingUsage(providers, "moonshot")).toBe(true);
  });

  it("does not enable streaming usage for arbitrary key with no baseUrl", () => {
    const provider = buildModelStudioProvider();
    delete (provider as { baseUrl?: string }).baseUrl;
    const providers = applyNativeStreamingUsageCompat({ custom: provider });
    expect(noModelStreamingUsage(providers, "custom")).toBe(true);
  });

  it("enables streaming usage for 'modelstudio' key with empty string baseUrl", () => {
    const providers = applyNativeStreamingUsageCompat({
      modelstudio: { ...buildModelStudioProvider(), baseUrl: "" },
    });
    expect(allModelsStreamingUsage(providers, "modelstudio")).toBe(true);
  });
});
