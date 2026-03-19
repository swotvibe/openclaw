import { describe, expect, it } from "vitest";
import {
  installPinnedHostnameTestHooks,
  resolveRequestUrl,
} from "../../src/media-understanding/providers/audio.test-helpers.js";
import { transcribeAimlApiAudio } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("transcribeAimlApiAudio", () => {
  it("uploads local audio as multipart with the file field", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push({ url: resolveRequestUrl(input), init });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ generation_id: "gen-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          result: {
            results: {
              channels: [{ alternatives: [{ transcript: "done" }] }],
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeAimlApiAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.ogg",
      mime: "audio/ogg; codecs=opus",
      apiKey: "test-key",
      timeoutMs: 5000,
      language: " en ",
      prompt: " hello ",
      fetchFn,
    });

    expect(result.text).toBe("done");
    expect(result.model).toBe("openai/gpt-4o-mini-transcribe");
    expect(requests[0]?.url).toBe("https://api.aimlapi.com/v1/stt/create");
    const firstInit = requests[0]?.init;
    const headers = new Headers(firstInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBeNull();
    const form = firstInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("openai/gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    expect(form.get("audio")).toBeNull();
    const file = form.get("file") as Blob | { name?: string; type?: string } | null;
    expect(file).not.toBeNull();
    if (file) {
      expect(file.type).toBe("audio/ogg");
      if ("name" in file && typeof file.name === "string") {
        expect(file.name).toBe("voice.ogg");
      }
    }
  });

  it("uses JSON url mode only when a source URL is provided", async () => {
    let seenBody: string | undefined;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (!seenBody) {
        seenBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ generation_id: "gen-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await transcribeAimlApiAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      sourceUrl: "https://example.com/voice.mp3",
      apiKey: "test-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(result.text).toBe("ok");
    expect(JSON.parse(seenBody ?? "{}")).toMatchObject({
      model: "openai/gpt-4o-mini-transcribe",
      url: "https://example.com/voice.mp3",
    });
  });

  it("treats waiting and active as pending and extracts nested transcripts", async () => {
    let callCount = 0;
    const fetchFn: typeof fetch = async (_input, _init) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ generation_id: "gen-3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (callCount === 2) {
        return new Response(JSON.stringify({ status: "waiting" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (callCount === 3) {
        return new Response(JSON.stringify({ status: "active" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          result: {
            results: {
              channels: [{ alternatives: [{ transcript: "nested transcript" }] }],
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeAimlApiAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice.mp3",
      apiKey: "test-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(result.text).toBe("nested transcript");
    expect(callCount).toBe(4);
  });

  it("throws a pending timeout when AIMLAPI never leaves queued status", async () => {
    const fetchFn: typeof fetch = async (_input, _init) => {
      if (_init?.method === "GET") {
        return new Response(JSON.stringify({ status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ generation_id: "gen-4" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      transcribeAimlApiAudio({
        buffer: Buffer.from("audio"),
        fileName: "voice.mp3",
        apiKey: "test-key",
        timeoutMs: 1,
        fetchFn,
      }),
    ).rejects.toThrow("pending timeout");
  });
});
