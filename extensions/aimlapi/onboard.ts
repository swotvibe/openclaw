import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildDefaultAimlApiChatModelDefinition } from "./discovery.js";
import {
  AIMLAPI_PROVIDER_ID,
  DEFAULT_AIMLAPI_CHAT_MODEL,
  resolveAimlApiBaseUrl,
} from "./shared.js";

export const AIMLAPI_DEFAULT_MODEL_REF = `${AIMLAPI_PROVIDER_ID}/${DEFAULT_AIMLAPI_CHAT_MODEL}`;

export function applyAimlApiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const providers = { ...cfg.models?.providers };
  const existingEntry = Object.entries(providers).find(
    ([key]) => normalizeProviderId(key) === AIMLAPI_PROVIDER_ID,
  );
  const existingProvider = existingEntry?.[1];
  if (existingEntry && existingEntry[0] !== AIMLAPI_PROVIDER_ID) {
    delete providers[existingEntry[0]];
  }

  const defaultModel = buildDefaultAimlApiChatModelDefinition();
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const mergedModels = existingModels.some((model) => model.id === defaultModel.id)
    ? existingModels
    : [...existingModels, defaultModel];

  providers[AIMLAPI_PROVIDER_ID] = {
    ...existingProvider,
    baseUrl: resolveAimlApiBaseUrl(cfg),
    models: mergedModels,
  };

  const models = { ...cfg.agents?.defaults?.models };
  models[AIMLAPI_DEFAULT_MODEL_REF] = {
    ...models[AIMLAPI_DEFAULT_MODEL_REF],
    alias: models[AIMLAPI_DEFAULT_MODEL_REF]?.alias ?? "Gemini",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyAimlApiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyAimlApiProviderConfig(cfg), AIMLAPI_DEFAULT_MODEL_REF);
}
