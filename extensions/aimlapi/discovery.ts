import type {
  OpenClawConfig,
  ProviderNormalizeResolvedModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { DEFAULT_CONTEXT_TOKENS, normalizeModelCompat } from "openclaw/plugin-sdk/provider-models";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  AIMLAPI_BASE_URL,
  AIMLAPI_DISCOVERY_URL,
  AIMLAPI_PROVIDER_ID,
  DEFAULT_AIMLAPI_CHAT_MODEL,
  resolveAimlApiBaseUrl,
  resolveAimlApiProviderConfig,
  stripAimlApiProviderPrefix,
} from "./shared.js";

const log = createSubsystemLogger("aimlapi-discovery");

const AIMLAPI_DISCOVERY_FRESH_MS = 30 * 60 * 1000;
const AIMLAPI_DISCOVERY_STALE_IF_ERROR_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 8192;
const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
const TOOL_FEATURE_SUFFIXES = [
  "openai/chat-completion.function",
  "openai/chat-completion.parallel-tool-calls",
];
const PREFERRED_DEFAULT_COMPAT = {
  supportsDeveloperRole: false,
  supportsTools: true,
  supportsReasoningEffort: false,
} as const;

type AimlApiRawRow = {
  id?: unknown;
  type?: unknown;
  info?: {
    name?: unknown;
    contextLength?: unknown;
    maxTokens?: unknown;
    docs_url?: unknown;
  };
  features?: unknown;
  endpoints?: unknown;
};

export type AimlApiDiscoveryStatus = "fresh" | "stale-last-known-good" | "manual-overrides-only";

export type AimlApiDiscoveryRow = {
  id: string;
  type: string;
  name: string;
  docsUrl?: string;
  features: string[];
  endpoints: string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  compat?: ModelDefinitionConfig["compat"];
  supportsChatCompletions: boolean;
  supportsResponses: boolean;
};

type AimlApiDiscoverySnapshot = {
  fetchedAt: number;
  rowsById: Map<string, AimlApiDiscoveryRow>;
  chatModels: ModelDefinitionConfig[];
  warnings: string[];
};

export type AimlApiDiscoveryState = {
  status: AimlApiDiscoveryStatus;
  fetchedAt?: number;
  rowsById: Map<string, AimlApiDiscoveryRow>;
  chatModels: ModelDefinitionConfig[];
  warnings: string[];
};

let cachedSnapshot: AimlApiDiscoverySnapshot | undefined;

function toFinitePositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function buildDefaultAimlApiCompat(): ModelDefinitionConfig["compat"] {
  return { ...PREFERRED_DEFAULT_COMPAT };
}

export function buildDefaultAimlApiChatModelDefinition(): ModelDefinitionConfig {
  return {
    id: DEFAULT_AIMLAPI_CHAT_MODEL,
    name: DEFAULT_AIMLAPI_CHAT_MODEL,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: buildDefaultAimlApiCompat(),
  };
}

function buildDefaultAimlApiRuntimeModel(
  modelId = DEFAULT_AIMLAPI_CHAT_MODEL,
): ProviderRuntimeModel {
  const fallback = buildDefaultAimlApiChatModelDefinition();
  return normalizeModelCompat({
    ...fallback,
    id: modelId,
    name: modelId,
    provider: AIMLAPI_PROVIDER_ID,
    baseUrl: AIMLAPI_BASE_URL,
  } as ProviderRuntimeModel) as ProviderRuntimeModel;
}

function hasToolSupport(features: string[]): boolean {
  return features.some((feature) => TOOL_FEATURE_SUFFIXES.includes(feature));
}

function buildAimlApiRow(entry: AimlApiRawRow): AimlApiDiscoveryRow | undefined {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const type = typeof entry.type === "string" ? entry.type.trim() : "";
  const endpoints = Array.isArray(entry.endpoints)
    ? entry.endpoints
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];
  if (!id || !type || endpoints.length === 0) {
    return undefined;
  }

  const features = Array.isArray(entry.features)
    ? entry.features.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
  const supportsChatCompletions = endpoints.includes("/v1/chat/completions");
  const supportsResponses =
    endpoints.includes("/v1/responses") || features.includes("openai/response-api");
  const reasoning = features.some((feature) => feature.toLowerCase().includes("reasoning"));
  const supportsDeveloperRole = features.includes("openai/chat-completion.message.developer");
  const input: Array<"text" | "image"> = features.includes("openai/chat-completion.vision")
    ? ["text", "image"]
    : ["text"];

  return {
    id,
    type,
    name:
      typeof entry.info?.name === "string" && entry.info.name.trim() ? entry.info.name.trim() : id,
    docsUrl:
      typeof entry.info?.docs_url === "string" && entry.info.docs_url.trim()
        ? entry.info.docs_url.trim()
        : undefined,
    features,
    endpoints,
    contextWindow: toFinitePositiveInt(entry.info?.contextLength) ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: toFinitePositiveInt(entry.info?.maxTokens) ?? DEFAULT_MAX_TOKENS,
    reasoning,
    input,
    compat: {
      supportsDeveloperRole,
      supportsTools: hasToolSupport(features),
      supportsReasoningEffort: reasoning,
      ...(features.includes("openai/chat-completion.max-completion-tokens")
        ? { maxTokensField: "max_completion_tokens" as const }
        : {}),
    },
    supportsChatCompletions,
    supportsResponses,
  };
}

function parseAimlApiDiscoveryPayload(payload: unknown): {
  rowsById: Map<string, AimlApiDiscoveryRow>;
  chatModels: ModelDefinitionConfig[];
  warnings: string[];
} {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error("AIMLAPI discovery response is missing a top-level data array.");
  }

  const warnings: string[] = [];
  const rowsById = new Map<string, AimlApiDiscoveryRow>();

  for (const [index, raw] of ((payload as { data: unknown[] }).data ?? []).entries()) {
    const row = buildAimlApiRow((raw ?? {}) as AimlApiRawRow);
    if (!row) {
      warnings.push(
        `Skipped AIMLAPI discovery row ${index} because id/type/endpoints were incomplete.`,
      );
      continue;
    }
    rowsById.set(row.id, row);
  }

  const chatModels = [...rowsById.values()]
    .filter((row) => row.supportsChatCompletions || row.supportsResponses)
    .map((row) => buildAimlApiModelDefinition(row))
    .toSorted((left, right) => left.id.localeCompare(right.id));

  return { rowsById, chatModels, warnings };
}

function snapshotToState(
  snapshot: AimlApiDiscoverySnapshot | undefined,
  status: AimlApiDiscoveryStatus,
  extraWarnings: string[] = [],
): AimlApiDiscoveryState {
  if (!snapshot) {
    return {
      status,
      rowsById: new Map<string, AimlApiDiscoveryRow>(),
      chatModels: [],
      warnings: extraWarnings,
    };
  }
  return {
    status,
    fetchedAt: snapshot.fetchedAt,
    rowsById: snapshot.rowsById,
    chatModels: snapshot.chatModels,
    warnings: [...snapshot.warnings, ...extraWarnings],
  };
}

function mapSupportedApis(row: AimlApiDiscoveryRow): ModelApi[] {
  const supported: ModelApi[] = [];
  if (row.supportsChatCompletions) {
    supported.push("openai-completions");
  }
  if (row.supportsResponses) {
    supported.push("openai-responses");
  }
  return supported;
}

function resolvePreferredModelApi(row: AimlApiDiscoveryRow): ModelApi | undefined {
  if (row.supportsChatCompletions) {
    return "openai-completions";
  }
  if (row.supportsResponses) {
    return "openai-responses";
  }
  return undefined;
}

function findConfiguredAimlApiModel(
  cfg: OpenClawConfig | undefined,
  modelId: string,
): ModelProviderConfig["models"][number] | undefined {
  const providerConfig = resolveAimlApiProviderConfig(cfg);
  const normalizedModelId = stripAimlApiProviderPrefix(modelId, modelId);
  return providerConfig?.models?.find((model) => model.id.trim() === normalizedModelId);
}

export function resolveConfiguredAimlApiModelApi(
  cfg: OpenClawConfig | undefined,
  modelId: string,
): ModelApi | undefined {
  const providerConfig = resolveAimlApiProviderConfig(cfg);
  const providerApi = providerConfig?.api;
  if (providerApi === "openai-completions" || providerApi === "openai-responses") {
    return providerApi;
  }
  const modelApi = findConfiguredAimlApiModel(cfg, modelId)?.api;
  return modelApi === "openai-completions" || modelApi === "openai-responses"
    ? modelApi
    : undefined;
}

function buildWrongEndpointError(row: AimlApiDiscoveryRow, api: ModelApi): Error {
  return new Error(
    `Wrong AIMLAPI endpoint for model "${row.id}": configured api "${api}" is not supported. Supported endpoints: ${mapSupportedApis(row).join(", ")}.`,
  );
}

function buildSurfaceMismatchError(row: AimlApiDiscoveryRow): Error {
  return new Error(
    `AIMLAPI model "${row.id}" does not support chat/agent turns. It is a "${row.type}" model with endpoints ${row.endpoints.join(", ")}.`,
  );
}

function buildUnknownAimlApiModelError(modelId: string): Error {
  return new Error(
    `Unknown AIMLAPI model "${modelId}". Discovery is unavailable or the model id is invalid. Add it to models.providers.aimlapi.models[] with an explicit api override if you need a manual fallback.`,
  );
}

export function buildAimlApiModelDefinition(row: AimlApiDiscoveryRow): ModelDefinitionConfig {
  const api = resolvePreferredModelApi(row);
  if (!api) {
    throw buildSurfaceMismatchError(row);
  }
  return {
    id: row.id,
    name: row.name,
    api,
    reasoning: row.reasoning,
    input: row.input,
    cost: { ...ZERO_COST },
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    compat: row.compat,
  };
}

export function resolveAimlApiDiscoveryRow(
  modelId: string,
  state: AimlApiDiscoveryState | undefined,
): AimlApiDiscoveryRow | undefined {
  return state?.rowsById.get(stripAimlApiProviderPrefix(modelId, modelId));
}

export function determineAimlApiModelApi(params: {
  cfg?: OpenClawConfig;
  modelId: string;
  row?: AimlApiDiscoveryRow;
  currentApi?: ModelApi;
}): ModelApi {
  const explicitApi = resolveConfiguredAimlApiModelApi(params.cfg, params.modelId);
  const requestedApi = explicitApi ?? params.currentApi;
  const row = params.row;

  if (row) {
    const preferredApi = resolvePreferredModelApi(row);
    if (!preferredApi) {
      throw buildSurfaceMismatchError(row);
    }
    if (requestedApi) {
      if (!mapSupportedApis(row).includes(requestedApi)) {
        throw buildWrongEndpointError(row, requestedApi);
      }
      return requestedApi;
    }
    return preferredApi;
  }

  if (requestedApi) {
    return requestedApi;
  }
  if (stripAimlApiProviderPrefix(params.modelId, params.modelId) === DEFAULT_AIMLAPI_CHAT_MODEL) {
    return "openai-completions";
  }
  throw buildUnknownAimlApiModelError(params.modelId);
}

function coerceAimlApiModelApi(api: ProviderRuntimeModel["api"] | undefined): ModelApi | undefined {
  if (api === "openai-completions") {
    return "openai-completions";
  }
  if (api === "openai-responses") {
    return "openai-responses";
  }
  return undefined;
}

export function buildAimlApiRuntimeModel(params: {
  cfg?: OpenClawConfig;
  modelId: string;
  row?: AimlApiDiscoveryRow;
  currentModel?: ProviderRuntimeModel;
}): ProviderRuntimeModel {
  const modelId = stripAimlApiProviderPrefix(params.modelId, params.modelId);
  const explicitApi = resolveConfiguredAimlApiModelApi(params.cfg, modelId);
  const shouldUseDefaultModel =
    modelId === DEFAULT_AIMLAPI_CHAT_MODEL || explicitApi === "openai-completions";
  const currentModel =
    params.currentModel ??
    (shouldUseDefaultModel ? buildDefaultAimlApiRuntimeModel(modelId) : undefined);
  const row = params.row;
  const api = determineAimlApiModelApi({
    cfg: params.cfg,
    modelId,
    row,
    currentApi: coerceAimlApiModelApi(currentModel?.api),
  });
  const fallbackModel = currentModel ?? buildDefaultAimlApiRuntimeModel(modelId);

  return normalizeModelCompat({
    ...fallbackModel,
    id: modelId,
    name: row?.name ?? fallbackModel.name ?? modelId,
    provider: AIMLAPI_PROVIDER_ID,
    api,
    baseUrl: resolveAimlApiBaseUrl(params.cfg),
    reasoning: row?.reasoning ?? fallbackModel.reasoning ?? false,
    input: row?.input ?? fallbackModel.input ?? ["text"],
    cost: row ? { ...ZERO_COST } : (fallbackModel.cost ?? { ...ZERO_COST }),
    contextWindow: row?.contextWindow ?? fallbackModel.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: row?.maxTokens ?? fallbackModel.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: row?.compat ?? fallbackModel.compat,
  } as ProviderRuntimeModel) as ProviderRuntimeModel;
}

export function normalizeAimlApiResolvedModel(
  ctx: ProviderNormalizeResolvedModelContext,
  state?: AimlApiDiscoveryState,
): ProviderRuntimeModel {
  return buildAimlApiRuntimeModel({
    cfg: ctx.config,
    modelId: ctx.modelId,
    row: resolveAimlApiDiscoveryRow(ctx.modelId, state),
    currentModel: ctx.model,
  });
}

export function getCachedAimlApiDiscoveryState(params?: {
  now?: number;
}): AimlApiDiscoveryState | undefined {
  if (!cachedSnapshot) {
    return undefined;
  }
  const now = params?.now ?? Date.now();
  const ageMs = now - cachedSnapshot.fetchedAt;
  if (ageMs < AIMLAPI_DISCOVERY_FRESH_MS) {
    return snapshotToState(cachedSnapshot, "fresh");
  }
  if (ageMs < AIMLAPI_DISCOVERY_STALE_IF_ERROR_MS) {
    return snapshotToState(cachedSnapshot, "stale-last-known-good");
  }
  return undefined;
}

export async function loadAimlApiDiscoveryState(params?: {
  fetchFn?: typeof fetch;
  now?: number;
  forceRefresh?: boolean;
}): Promise<AimlApiDiscoveryState> {
  const now = params?.now ?? Date.now();
  const cached = getCachedAimlApiDiscoveryState({ now });
  if (cached && !params?.forceRefresh && cached.status === "fresh") {
    return cached;
  }

  try {
    const response = await (params?.fetchFn ?? fetch)(AIMLAPI_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`AIMLAPI discovery failed (HTTP ${response.status}).`);
    }
    const payload = await response.json();
    const parsed = parseAimlApiDiscoveryPayload(payload);
    cachedSnapshot = {
      fetchedAt: now,
      rowsById: parsed.rowsById,
      chatModels: parsed.chatModels,
      warnings: parsed.warnings,
    };
    return snapshotToState(cachedSnapshot, "fresh");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`AIMLAPI discovery refresh failed: ${message}`);
    if (cachedSnapshot && now - cachedSnapshot.fetchedAt < AIMLAPI_DISCOVERY_STALE_IF_ERROR_MS) {
      return snapshotToState(cachedSnapshot, "stale-last-known-good", [message]);
    }
    return snapshotToState(undefined, "manual-overrides-only", [message]);
  }
}

export function resetAimlApiDiscoveryCacheForTest(): void {
  cachedSnapshot = undefined;
}
