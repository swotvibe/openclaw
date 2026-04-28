import {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  describeImageWithModel,
  describeImagesWithModel,
  resolveMediaUnderstandingString,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
  type OpenAiCompatibleVideoPayload,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { QWEN_STANDARD_CN_BASE_URL, QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_VIDEO_MODEL = "qwen-vl-max-latest";
const DEFAULT_QWEN_VIDEO_PROMPT = "Describe the video in detail.";
const DEFAULT_QWEN_AUDIO_MODEL = "qwen3.5-omni-flash";
const DEFAULT_QWEN_AUDIO_PROMPT = "Transcribe the audio content accurately.";

function resolveQwenStandardBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
  providerId: string,
): string {
  const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
  if (!direct) {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
  try {
    const url = new URL(direct);
    if (url.hostname === "coding-intl.dashscope.aliyuncs.com") {
      return QWEN_STANDARD_GLOBAL_BASE_URL;
    }
    if (url.hostname === "coding.dashscope.aliyuncs.com") {
      return QWEN_STANDARD_CN_BASE_URL;
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  } catch {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
}

/** Extract the base audio format from a MIME type, stripping parameters and normalizing. */
export function extractAudioFormat(mime: string | undefined): string {
  const cleaned = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  const slashIdx = cleaned.lastIndexOf("/");
  const format = slashIdx >= 0 ? cleaned.slice(slashIdx + 1) : cleaned;
  // Qwen API supports: wav, mp3, m4a, ogg, flac
  // Map ogg variants (e.g. ogg from audio/ogg; codecs=opus) to "ogg"
  if (format === "ogg" || format === "oga") {
    return "ogg";
  }
  if (format === "opus") {
    return "opus";
  }
  return format || "wav";
}

export async function describeQwenVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_QWEN_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_QWEN_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "qwen",
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });

  const { response: res, release } = await postJsonRequest({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: buildOpenAiCompatibleVideoRequestBody({
      model,
      prompt,
      mime,
      buffer: params.buffer,
    }),
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Qwen video description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Qwen video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

type StreamChunk = {
  choices?: Array<{ delta?: { content?: string } }>;
};

export async function transcribeQwenAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = params.model?.trim() || DEFAULT_QWEN_AUDIO_MODEL;
  const prompt = params.prompt?.trim() || DEFAULT_QWEN_AUDIO_PROMPT;
  const mime = params.mime?.trim() || "audio/wav";
  const { baseUrl, headers } = resolveProviderHttpRequestConfig({
    baseUrl: params.baseUrl,
    defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
    headers: params.headers,
    request: params.request,
    defaultHeaders: {
      "content-type": "application/json",
      authorization: `Bearer ${params.apiKey}`,
    },
    provider: "qwen",
    api: "openai-completions",
    capability: "audio",
    transport: "media-understanding",
  });

  const format = extractAudioFormat(mime);
  const audioDataUri = `data:${mime};base64,${params.buffer.toString("base64")}`;

  const response = await fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "input_audio",
              input_audio: { data: audioDataUri, format },
            },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Qwen audio transcription failed (${response.status}): ${errorText || response.statusText}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Qwen audio transcription: no response body");
  }

  const decoder = new TextDecoder();
  let sseBuffer = "";
  const textChunks: string[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        try {
          const chunk = JSON.parse(data) as StreamChunk;
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            textChunks.push(content);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const text = textChunks.join("").trim();
  if (!text) {
    throw new Error("Qwen audio transcription returned empty content");
  }
  return { text, model };
}

export function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "qwen",
    capabilities: ["audio", "image", "video"],
    defaultModels: {
      audio: DEFAULT_QWEN_AUDIO_MODEL,
      image: "qwen-vl-max-latest",
      video: DEFAULT_QWEN_VIDEO_MODEL,
    },
    autoPriority: {
      audio: 15,
      video: 15,
    },
    transcribeAudio: transcribeQwenAudio,
    describeImage: describeImageWithModel,
    describeImages: describeImagesWithModel,
    describeVideo: describeQwenVideo,
  };
}

export function resolveQwenMediaUnderstandingBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string {
  return resolveQwenStandardBaseUrl(cfg, "qwen");
}
