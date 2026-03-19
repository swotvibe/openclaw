import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-onboard";

export const AIMLAPI_PROVIDER_ID = "aimlapi";
export const AIMLAPI_BASE_URL = "https://api.aimlapi.com/v1";
export const AIMLAPI_DISCOVERY_URL = "https://api.aimlapi.com/models";
export const DEFAULT_AIMLAPI_CHAT_MODEL = "google/gemini-3-pro-preview";
export const DEFAULT_AIMLAPI_IMAGE_MODEL = "openai/gpt-image-1";
export const DEFAULT_AIMLAPI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_AIMLAPI_STT_MODEL = "openai/gpt-4o-mini-transcribe";
export const DEFAULT_AIMLAPI_TTS_MODEL = "openai/tts-1";

function findAimlApiProviderEntry(
  cfg?: OpenClawConfig,
): [key: string, value: ModelProviderConfig] | undefined {
  const providers = cfg?.models?.providers ?? {};
  return Object.entries(providers).find(
    ([key]) => normalizeProviderId(key) === AIMLAPI_PROVIDER_ID,
  ) as [string, ModelProviderConfig] | undefined;
}

export function resolveAimlApiProviderConfig(
  cfg?: OpenClawConfig,
): ModelProviderConfig | undefined {
  return findAimlApiProviderEntry(cfg)?.[1];
}

export function resolveAimlApiBaseUrl(cfg?: OpenClawConfig): string {
  return resolveAimlApiProviderConfig(cfg)?.baseUrl?.trim() || AIMLAPI_BASE_URL;
}

export function resolveAimlApiEnvApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.AIMLAPI_API_KEY?.trim() || env.AIMLAPI_KEY?.trim() || undefined;
}

export function hasAimlApiCredential(cfg?: OpenClawConfig): boolean {
  const apiKey = resolveAimlApiProviderConfig(cfg)?.apiKey;
  return (
    (typeof apiKey === "string" && apiKey.trim().length > 0) || Boolean(resolveAimlApiEnvApiKey())
  );
}

export function stripAimlApiProviderPrefix(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.toLowerCase().startsWith(`${AIMLAPI_PROVIDER_ID}/`)
    ? trimmed.slice(AIMLAPI_PROVIDER_ID.length + 1).trim()
    : trimmed;
}

export function normalizeAimlApiOpenAiSurfaceModel(
  model: string | undefined,
  fallback: string,
): string {
  const trimmed = stripAimlApiProviderPrefix(model, fallback);
  if (!trimmed || trimmed.includes("/") || trimmed.startsWith("#")) {
    return trimmed || fallback;
  }
  return `openai/${trimmed}`;
}

export function toAimlApiDataUrl(buffer: Buffer, mime?: string): string {
  const contentType = mime?.trim() || "application/octet-stream";
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}
