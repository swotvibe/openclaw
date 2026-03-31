import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveProviderAttributionHeaders } from "../provider-attribution.js";
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

function isOpenRouterAnthropicModel(provider: string, modelId: string): boolean {
  return provider.toLowerCase() === "openrouter" && modelId.toLowerCase().startsWith("anthropic/");
}

function mapThinkingLevelToOpenRouterReasoningEffort(
  thinkingLevel: ThinkLevel,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (thinkingLevel === "off") {
    return "none";
  }
  if (thinkingLevel === "adaptive") {
    return "medium";
  }
  return thinkingLevel;
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
      reasoningObj.effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payloadObj.reasoning = {
      effort: mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel),
    };
  }
}

export function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      typeof model.provider !== "string" ||
      typeof model.id !== "string" ||
      !isOpenRouterAnthropicModel(model.provider, model.id)
    ) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const messages = payloadObj.messages;
      if (Array.isArray(messages)) {
        for (const msg of messages as Array<{ role?: string; content?: unknown }>) {
          if (msg.role !== "system" && msg.role !== "developer") {
            continue;
          }
          if (typeof msg.content === "string") {
            msg.content = [
              { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
            ];
          } else if (Array.isArray(msg.content) && msg.content.length > 0) {
            const last = msg.content[msg.content.length - 1];
            if (last && typeof last === "object") {
              (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
            }
          }
        }
      }
    });
  };
}

export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const attributionHeaders = resolveProviderAttributionHeaders("openrouter");
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...attributionHeaders,
          ...options?.headers,
        },
      },
      (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}

export function isProxyReasoningUnsupported(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("x-ai/");
}

export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...options?.headers,
          ...resolveKilocodeAppHeaders(),
        },
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
