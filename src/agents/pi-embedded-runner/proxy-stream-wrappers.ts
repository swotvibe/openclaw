import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { normalizeOptionalLowercaseString, readStringValue } from "../../shared/string-coerce.js";
import { resolveProviderRequestPolicy } from "../provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-cache-control-payload.js";
import { isAnthropicModelRef } from "./anthropic-family-cache-semantics.js";
import { mapThinkingLevelToReasoningEffort } from "./reasoning-effort-utils.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

function isAimlApiModel(model: { provider?: unknown; baseUrl?: unknown; api?: unknown }): boolean {
  if (model.api !== "openai-completions") {
    return false;
  }
  if (typeof model.provider === "string" && model.provider.trim().toLowerCase() === "aimlapi") {
    return true;
  }
  if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    return false;
  }
  try {
    return new URL(model.baseUrl).hostname.toLowerCase().endsWith("aimlapi.com");
  } catch {
    return model.baseUrl.toLowerCase().includes("aimlapi.com");
  }
}

function stringifyAimlApiMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

export function normalizeAimlApiToolPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown; tool_calls?: unknown };
    if (record.role === "assistant" && Array.isArray(record.tool_calls) && record.content == null) {
      record.content = "";
      continue;
    }
    if (record.role === "tool" && typeof record.content !== "string") {
      record.content = stringifyAimlApiMessageContent(record.content);
    }
  }
}

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

function normalizeProxyReasoningPayload(payload: unknown, thinkingLevel?: ThinkLevel): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const payloadObj = payload as Record<string, unknown>;
  delete payloadObj.reasoning_effort;
  if (!thinkingLevel || thinkingLevel === "off") {
    return;
  }

  const existingReasoning = payloadObj.reasoning;
  if (
    existingReasoning &&
    typeof existingReasoning === "object" &&
    !Array.isArray(existingReasoning)
  ) {
    const reasoningObj = existingReasoning as Record<string, unknown>;
    if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
      reasoningObj.effort = mapThinkingLevelToReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payloadObj.reasoning = {
      effort: mapThinkingLevelToReasoningEffort(thinkingLevel),
    };
  }
}

export function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const provider = readStringValue(model.provider);
    const modelId = readStringValue(model.id);
    // Keep OpenRouter-specific cache markers on verified OpenRouter routes
    // (or the provider's default route), but not on arbitrary OpenAI proxies.
    const endpointClass = resolveProviderRequestPolicy({
      provider,
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
    }).endpointClass;
    if (
      !modelId ||
      !isAnthropicModelRef(modelId) ||
      !(
        endpointClass === "openrouter" ||
        (endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter")
      )
    ) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      applyAnthropicEphemeralCacheControlMarkers(payloadObj);
    });
  };
}

export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const headers = resolveProviderRequestPolicyConfig({
      provider: readStringValue(model.provider) ?? "openrouter",
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      precedence: "caller-wins",
    }).headers;
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers,
      },
      (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}

export function isProxyReasoningUnsupported(modelId: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}

export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const headers = resolveProviderRequestPolicyConfig({
      provider: readStringValue(model.provider) ?? "kilocode",
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      providerHeaders: resolveKilocodeAppHeaders(),
      precedence: "defaults-win",
    }).headers;
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers,
      },
      (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}

export function createAimlApiPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isAimlApiModel(model)) {
      return underlying(model, context, options);
    }
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        normalizeAimlApiToolPayload(payload);
        return onPayload?.(payload, model);
      },
    });
  };
}
