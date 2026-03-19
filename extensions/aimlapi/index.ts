import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import {
  buildAimlApiRuntimeModel,
  buildDefaultAimlApiChatModelDefinition,
  getCachedAimlApiDiscoveryState,
  loadAimlApiDiscoveryState,
  normalizeAimlApiResolvedModel,
  resolveAimlApiDiscoveryRow,
} from "./discovery.js";
import { buildAimlApiImageGenerationProvider } from "./image-generation-provider.js";
import { aimlapiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyAimlApiConfig } from "./onboard.js";
import {
  AIMLAPI_PROVIDER_ID,
  DEFAULT_AIMLAPI_CHAT_MODEL,
  resolveAimlApiBaseUrl,
  resolveAimlApiProviderConfig,
} from "./shared.js";
import { buildAimlApiSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: AIMLAPI_PROVIDER_ID,
  name: "AIMLAPI Provider",
  description: "Bundled AIMLAPI provider plugins",
  register(api) {
    api.registerProvider({
      id: AIMLAPI_PROVIDER_ID,
      label: "AIMLAPI",
      docsPath: "/providers/models",
      envVars: ["AIMLAPI_API_KEY", "AIMLAPI_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: AIMLAPI_PROVIDER_ID,
          methodId: "api-key",
          label: "AIMLAPI API key",
          hint: "Single AIMLAPI key for all supported surfaces",
          optionKey: "aimlapiApiKey",
          flagName: "--aimlapi-api-key",
          envVar: "AIMLAPI_API_KEY",
          promptMessage: "Enter AIMLAPI API key",
          defaultModel: `${AIMLAPI_PROVIDER_ID}/${DEFAULT_AIMLAPI_CHAT_MODEL}`,
          expectedProviders: [AIMLAPI_PROVIDER_ID],
          applyConfig: (cfg) => applyAimlApiConfig(cfg),
          wizard: {
            choiceId: "aimlapi-api-key",
            choiceLabel: "AIMLAPI API key",
            groupId: AIMLAPI_PROVIDER_ID,
            groupLabel: "AIMLAPI",
            groupHint: "One API key for chat, vision, speech, images, and embeddings",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const configProvider = resolveAimlApiProviderConfig(ctx.config);
          const discovery = await loadAimlApiDiscoveryState();
          const resolvedApiKey = ctx.resolveProviderApiKey(AIMLAPI_PROVIDER_ID).apiKey;
          if (!resolvedApiKey && !configProvider) {
            return null;
          }
          const { api: _ignoredApi, ...providerWithoutApi } = configProvider ?? {};
          const models =
            discovery.chatModels.length > 0
              ? discovery.chatModels
              : Array.isArray(configProvider?.models) && configProvider.models.length > 0
                ? configProvider.models
                : [buildDefaultAimlApiChatModelDefinition()];
          return {
            provider: {
              ...providerWithoutApi,
              ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
              baseUrl: resolveAimlApiBaseUrl(ctx.config),
              models,
            },
          };
        },
      },
      prepareDynamicModel: async () => {
        await loadAimlApiDiscoveryState();
      },
      resolveDynamicModel: (ctx) => {
        if (normalizeProviderId(ctx.provider) !== AIMLAPI_PROVIDER_ID) {
          return undefined;
        }
        const state = getCachedAimlApiDiscoveryState();
        const row = resolveAimlApiDiscoveryRow(ctx.modelId, state);
        if (row) {
          return buildAimlApiRuntimeModel({
            cfg: ctx.config,
            modelId: ctx.modelId,
            row,
          });
        }
        if (ctx.modelId.trim() === DEFAULT_AIMLAPI_CHAT_MODEL) {
          return buildAimlApiRuntimeModel({
            cfg: ctx.config,
            modelId: ctx.modelId,
          });
        }
        return undefined;
      },
      normalizeResolvedModel: (ctx) => {
        if (normalizeProviderId(ctx.provider) !== AIMLAPI_PROVIDER_ID) {
          return undefined;
        }
        return normalizeAimlApiResolvedModel(ctx, getCachedAimlApiDiscoveryState());
      },
      capabilities: {
        providerFamily: "openai",
      },
      isModernModelRef: () => true,
    });
    api.registerSpeechProvider(buildAimlApiSpeechProvider());
    api.registerMediaUnderstandingProvider(aimlapiMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildAimlApiImageGenerationProvider());
  },
});
