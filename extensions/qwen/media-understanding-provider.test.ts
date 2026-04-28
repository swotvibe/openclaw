import { describe, expect, it, vi } from "vitest";
import { createRequestCaptureJsonFetch } from "../../test/helpers/plugins/media-understanding.js";
import {
  describeQwenVideo,
  extractAudioFormat,
  transcribeQwenAudio,
} from "./media-understanding-provider.js";

describe("extractAudioFormat", () => {
  it.each([
    ["audio/wav", "wav"],
    ["audio/mp3", "mp3"],
    ["audio/mpeg", "mpeg"],
    ["audio/ogg", "ogg"],
    ["audio/ogg; codecs=opus", "ogg"],
    [" Audio/Ogg; codecs=opus ", "ogg"],
    ["audio/oga", "ogg"],
    ["audio/opus", "opus"],
    ["audio/m4a", "m4a"],
    ["audio/flac", "flac"],
    ["audio/webm", "webm"],
    [undefined, "wav"],
    ["", "wav"],
    ["application/octet-stream", "octet-stream"],
  ])("maps %s => %s", (mime, expected) => {
    expect(extractAudioFormat(mime)).toBe(expected);
  });
});

describe("transcribeQwenAudio", () => {
  const mockAudioBuffer = Buffer.from("fake-audio-bytes");

  function createSseResponse(chunks: string[]) {
    const body = chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`)
      .join("")
      .concat("data: [DONE]\n");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  }

  it("sends the correct format for audio/ogg; codecs=opus", async () => {
    const fetchFn = vi.fn().mockResolvedValue(createSseResponse(["hello", " world"]));

    await transcribeQwenAudio({
      buffer: mockAudioBuffer,
      fileName: "voice.ogg",
      mime: "audio/ogg; codecs=opus",
      apiKey: "test-key",
      timeoutMs: 5000,
      baseUrl: "https://example.com/v1",
      model: "qwen3.5-omni-flash",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    const inputAudio = body.messages[0].content[1].input_audio;
    expect(inputAudio.format).toBe("ogg");
    expect(inputAudio.data).toContain("audio/ogg; codecs=opus");
  });

  it("defaults to wav when MIME type is missing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(createSseResponse(["transcribed"]));

    await transcribeQwenAudio({
      buffer: mockAudioBuffer,
      fileName: "audio",
      mime: "",
      apiKey: "test-key",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.messages[0].content[1].input_audio.format).toBe("wav");
  });

  it("extracts opus format from audio/opus MIME", async () => {
    const fetchFn = vi.fn().mockResolvedValue(createSseResponse(["test"]));

    await transcribeQwenAudio({
      buffer: mockAudioBuffer,
      fileName: "audio.opus",
      mime: "audio/opus",
      apiKey: "test-key",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.messages[0].content[1].input_audio.format).toBe("opus");
  });
});

describe("describeQwenVideo", () => {
  it("builds the expected OpenAI-compatible video payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [
        {
          message: {
            content: [{ text: " first " }, { text: "second" }],
          },
        },
      ],
    });

    const result = await describeQwenVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      mime: "video/mp4",
      apiKey: "test-key",
      timeoutMs: 1500,
      baseUrl: "https://example.com/v1",
      model: "qwen-vl-max",
      prompt: "summarize the clip",
      headers: { "X-Other": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.model).toBe("qwen-vl-max");
    expect(result.text).toBe("first\nsecond");
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : Buffer.isBuffer(init?.body)
          ? init.body.toString("utf8")
          : "";
    const body = JSON.parse(bodyText);
    expect(body.model).toBe("qwen-vl-max");
    expect(body.messages?.[0]?.content?.[0]?.text).toBe("summarize the clip");
    expect(body.messages?.[0]?.content?.[1]?.type).toBe("video_url");
    expect(body.messages?.[0]?.content?.[1]?.video_url?.url).toBe(
      `data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}`,
    );
  });
});
