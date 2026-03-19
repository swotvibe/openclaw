import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type AimlApiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

export const DEFAULT_AIMLAPI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_AIMLAPI_EMBEDDING_BASE_URL = "https://api.aimlapi.com/v1";

export function normalizeAimlApiEmbeddingModel(model: string): string {
  const normalized = normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_AIMLAPI_EMBEDDING_MODEL,
    prefixes: ["aimlapi/"],
  });
  return normalized.startsWith("openai/") ? normalized.slice("openai/".length) : normalized;
}

export async function createAimlApiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: AimlApiEmbeddingClient }> {
  const client = await resolveAimlApiEmbeddingClient(options);

  return {
    provider: createRemoteEmbeddingProvider({
      id: "aimlapi",
      client,
      errorPrefix: "aimlapi embeddings failed",
    }),
    client,
  };
}

export async function resolveAimlApiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<AimlApiEmbeddingClient> {
  return await resolveRemoteEmbeddingClient({
    provider: "aimlapi",
    options,
    defaultBaseUrl: DEFAULT_AIMLAPI_EMBEDDING_BASE_URL,
    normalizeModel: normalizeAimlApiEmbeddingModel,
  });
}
