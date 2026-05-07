import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { extractAssistantText } from "../agents/pi-embedded-utils.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ActiveMediaModel } from "./runner.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../agents/pi-model-discovery-runtime.js")
> | null = null;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

function buildAudioSummaryContext(transcript: string): Context {
  return {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Summarize this audio transcript for downstream agent context. " +
              "Keep the original language when clear. Be concise and factual. " +
              "Capture the user's intent, requests, constraints, names, dates, numbers, and action items. " +
              "Do not add an introduction or mention that this is a summary.\n\n" +
              `Transcript:\n${transcript}`,
          },
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

function coerceAudioSummaryText(params: {
  message: Awaited<ReturnType<typeof complete>>;
  provider: string;
  model: string;
}): string {
  const stop = params.message.stopReason;
  const errorMessage = params.message.errorMessage?.trim();
  if (stop === "error" || stop === "aborted") {
    throw new Error(
      errorMessage
        ? `Audio summary model failed (${params.provider}/${params.model}): ${errorMessage}`
        : `Audio summary model failed (${params.provider}/${params.model})`,
    );
  }
  if (errorMessage) {
    throw new Error(
      `Audio summary model failed (${params.provider}/${params.model}): ${errorMessage}`,
    );
  }
  const text = extractAssistantText(params.message).trim();
  if (!text) {
    throw new Error(`Audio summary model returned no text (${params.provider}/${params.model}).`);
  }
  return text;
}

async function resolveAudioSummaryRuntime(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  activeModel: ActiveMediaModel;
}): Promise<{ apiKey: string; model: Model<Api> }> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const modelId = params.activeModel.model?.trim();
  if (!modelId) {
    throw new Error("Audio summary model id is required.");
  }
  const resolvedRef = normalizeModelRef(params.activeModel.provider, modelId);
  const model = modelRegistry.find(resolvedRef.provider, resolvedRef.model) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown audio summary model: ${resolvedRef.provider}/${resolvedRef.model}`);
  }
  const apiKey = requireApiKey(
    await getApiKeyForModel({
      model,
      cfg: params.cfg,
      agentDir: params.agentDir,
    }),
    model.provider,
  );
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return { apiKey, model };
}

export async function summarizeAudioTranscript(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel?: ActiveMediaModel;
  transcript: string;
  maxTokens?: number;
}): Promise<string | undefined> {
  const transcript = params.transcript.trim();
  if (
    !transcript ||
    !params.agentDir ||
    !params.activeModel?.provider ||
    !params.activeModel.model
  ) {
    return undefined;
  }

  const { apiKey, model } = await resolveAudioSummaryRuntime({
    cfg: params.cfg,
    agentDir: params.agentDir,
    activeModel: params.activeModel,
  });
  const message = await complete(model, buildAudioSummaryContext(transcript), {
    apiKey,
    maxTokens: params.maxTokens,
  });
  return coerceAudioSummaryText({
    message,
    provider: model.provider,
    model: model.id,
  });
}
