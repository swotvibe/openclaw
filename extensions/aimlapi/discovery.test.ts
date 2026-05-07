import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAimlApiRuntimeModel,
  determineAimlApiModelApi,
  loadAimlApiDiscoveryState,
  normalizeAimlApiResolvedModel,
  resetAimlApiDiscoveryCacheForTest,
} from "./discovery.js";

const CHAT_ONLY_ROW = {
  id: "google/gemini-3-pro-preview",
  type: "chat-completion",
  info: {
    name: "Gemini 3 Pro Preview",
    contextLength: 1_000_000,
    maxTokens: 8_192,
  },
  features: [
    "openai/chat-completion.message.system",
    "openai/chat-completion.parallel-tool-calls",
    "openai/chat-completion.stream",
  ],
  endpoints: ["/v1/chat/completions"],
};

const RESPONSES_ONLY_ROW = {
  id: "openai/o3-pro",
  type: "responses",
  info: {
    name: "o3-pro",
    contextLength: 200_000,
    maxTokens: 16_384,
  },
  features: [
    "openai/response-api",
    "openai/chat-completion.message.developer",
    "openai/chat-completion.parallel-tool-calls",
    "openai/chat-completion.reasoning",
  ],
  endpoints: ["/v1/responses"],
};

const BOTH_ENDPOINTS_ROW = {
  id: "openai/gpt-4o",
  type: "chat-completion",
  info: {
    name: "GPT-4o",
    contextLength: 128_000,
    maxTokens: 16_384,
  },
  features: [
    "openai/response-api",
    "openai/chat-completion.message.developer",
    "openai/chat-completion.parallel-tool-calls",
  ],
  endpoints: ["/v1/chat/completions", "/v1/responses"],
};

const EMBEDDING_ROW = {
  id: "text-embedding-3-small",
  type: "embedding",
  info: {
    name: "text-embedding-3-small",
    contextLength: 8_192,
    maxTokens: 8_192,
  },
  features: [],
  endpoints: ["/v1/embeddings"],
};

function createDiscoveryResponse(rows: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      object: "list",
      data: rows,
    }),
  } as Response;
}

function createFetchFn(rows: unknown[]): typeof fetch {
  return (async () => createDiscoveryResponse(rows)) as unknown as typeof fetch;
}

function createRejectingFetchFn(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("aimlapi discovery", () => {
  beforeEach(() => {
    resetAimlApiDiscoveryCacheForTest();
  });

  it("chooses chat completions for chat-only rows", async () => {
    const state = await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([CHAT_ONLY_ROW]),
      now: 0,
      forceRefresh: true,
    });

    expect(state.status).toBe("fresh");
    expect(state.chatModels[0]?.api).toBe("openai-completions");
  });

  it("chooses responses for responses-only rows", async () => {
    const state = await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([RESPONSES_ONLY_ROW]),
      now: 0,
      forceRefresh: true,
    });

    expect(state.chatModels[0]?.api).toBe("openai-responses");
  });

  it("prefers chat completions when both endpoints are available", async () => {
    const state = await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([BOTH_ENDPOINTS_ROW]),
      now: 0,
      forceRefresh: true,
    });

    expect(state.chatModels[0]?.api).toBe("openai-completions");
  });

  it("keeps valid rows when partial metadata rows are invalid", async () => {
    const state = await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([
        CHAT_ONLY_ROW,
        {
          id: "",
          type: "chat-completion",
          endpoints: [],
        },
      ]),
      now: 0,
      forceRefresh: true,
    });

    expect(state.chatModels.map((model) => model.id)).toEqual([CHAT_ONLY_ROW.id]);
    expect(
      state.warnings.some((warning) => warning.includes("Skipped AIMLAPI discovery row")),
    ).toBe(true);
  });

  it("keeps a stale last-known-good snapshot before falling back to manual-only state", async () => {
    await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([CHAT_ONLY_ROW]),
      now: 0,
      forceRefresh: true,
    });

    const stale = await loadAimlApiDiscoveryState({
      fetchFn: createRejectingFetchFn("network down"),
      now: 31 * 60 * 1000,
      forceRefresh: true,
    });
    expect(stale.status).toBe("stale-last-known-good");
    expect(stale.chatModels.map((model) => model.id)).toEqual([CHAT_ONLY_ROW.id]);

    const manualOnly = await loadAimlApiDiscoveryState({
      fetchFn: createRejectingFetchFn("still down"),
      now: 7 * 60 * 60 * 1000,
      forceRefresh: true,
    });
    expect(manualOnly.status).toBe("manual-overrides-only");
    expect(manualOnly.chatModels).toEqual([]);
  });

  it("throws a wrong-endpoint error when config forces an unsupported api", async () => {
    const state = await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([CHAT_ONLY_ROW]),
      now: 0,
      forceRefresh: true,
    });

    expect(() =>
      normalizeAimlApiResolvedModel(
        {
          provider: "aimlapi",
          modelId: CHAT_ONLY_ROW.id,
          config: {
            models: {
              providers: {
                aimlapi: {
                  baseUrl: "https://api.aimlapi.com/v1",
                  api: "openai-responses",
                  models: [],
                },
              },
            },
          },
          model: buildAimlApiRuntimeModel({
            modelId: CHAT_ONLY_ROW.id,
          }),
        },
        state,
      ),
    ).toThrow(/configured api "openai-responses" is not supported/i);
  });

  it("throws a surface mismatch for non-chat AIMLAPI rows", async () => {
    const state = await loadAimlApiDiscoveryState({
      fetchFn: createFetchFn([EMBEDDING_ROW]),
      now: 0,
      forceRefresh: true,
    });

    expect(() =>
      determineAimlApiModelApi({
        modelId: EMBEDDING_ROW.id,
        row: state.rowsById.get(EMBEDDING_ROW.id),
      }),
    ).toThrow(/does not support chat\/agent turns/i);
  });

  it("throws a model-not-found hint when discovery has no row and no explicit api", () => {
    expect(() =>
      buildAimlApiRuntimeModel({
        modelId: "unknown/provider-model",
      }),
    ).toThrow(/Unknown AIMLAPI model/i);
  });
});
