import {
  applyModelStudioNativeStreamingUsageCompat,
  isNativeModelStudioBaseUrl,
} from "../plugin-sdk/modelstudio.js";
import {
  applyMoonshotNativeStreamingUsageCompat,
  isNativeMoonshotBaseUrl,
} from "../plugin-sdk/moonshot.js";
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
  resolveProviderRuntimePlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

/**
 * URL-based fallback for streaming usage compat when no plugin claims the
 * provider key. Users may register DashScope or Moonshot endpoints under
 * arbitrary provider key names (e.g. "dashscope", "qwen", "kimi") while
 * still pointing at the real native API. The plugin system resolves hooks
 * by provider key, so such custom keys bypass the owning plugin entirely.
 * This fallback checks the baseUrl directly and delegates to the correct
 * plugin's compat function when the URL matches a known native endpoint.
 */
function applyNativeStreamingUsageCompatByUrl(
  provider: ProviderConfig,
): ProviderConfig | undefined {
  if (isNativeModelStudioBaseUrl(provider.baseUrl)) {
    return applyModelStudioNativeStreamingUsageCompat(provider);
  }
  if (isNativeMoonshotBaseUrl(provider.baseUrl)) {
    return applyMoonshotNativeStreamingUsageCompat(provider);
  }
  return undefined;
}

export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    // First, try the standard plugin-based hook (matches by provider key).
    // If no plugin claims the key, fall back to URL-based detection so that
    // native DashScope/Moonshot URLs get streaming usage enabled regardless
    // of the provider key the user chose in their config.
    const nextProvider =
      applyProviderNativeStreamingUsageCompatWithPlugin({
        provider: providerKey,
        context: {
          provider: providerKey,
          providerConfig: provider,
        },
      }) ??
      applyNativeStreamingUsageCompatByUrl(provider) ??
      provider;
    nextProviders[providerKey] = nextProvider;
    changed ||= nextProvider !== provider;
  }

  return changed ? nextProviders : providers;
}

export function normalizeProviderSpecificConfig(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  return (
    normalizeProviderConfigWithPlugin({
      provider: providerKey,
      context: {
        provider: providerKey,
        providerConfig: provider,
      },
    }) ?? provider
  );
}

export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  if (!resolveProviderRuntimePlugin({ provider: providerKey })?.resolveConfigApiKey) {
    return undefined;
  }
  return (env) => {
    const resolved = resolveProviderConfigApiKeyWithPlugin({
      provider: providerKey,
      env,
      context: {
        provider: providerKey,
        env,
      },
    });
    return resolved?.trim() || undefined;
  };
}
