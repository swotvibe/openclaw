import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createAimlApiPayloadCompatibilityWrapper,
  createOpenRouterWrapper,
} from "./proxy-stream-wrappers.js";

describe("proxy stream wrappers", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({
        headers: options?.headers,
      });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn);
    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
          "X-OpenRouter-Categories": "cli-agent",
          "X-Custom": "1",
        },
      },
    ]);
  });

  it("normalizes AIMLAPI tool roundtrip payloads", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: '{"file_path":"SOUL.md"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: [{ type: "text", text: "# SOUL\nhello" }],
          },
        ],
      };
      options?.onPayload?.(payload, model);
      capturedPayload = payload as Record<string, unknown>;
      return createAssistantMessageEventStream();
    };

    const wrapped = createAimlApiPayloadCompatibilityWrapper(baseStreamFn);
    const model = {
      api: "openai-completions",
      provider: "aimlapi",
      id: "google/gemini-3-pro-preview",
      baseUrl: "https://api.aimlapi.com/v1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, {});

    const messages = capturedPayload?.messages as Array<{ content?: unknown }>;
    expect(messages[1]?.content).toBe("");
    expect(messages[2]?.content).toBe("# SOUL\nhello");
  });
});
