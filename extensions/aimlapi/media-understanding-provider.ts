import {
  assertOkOrThrowHttpError,
  describeImageWithModel,
  describeImagesWithModel,
  normalizeBaseUrl,
  postJsonRequest,
  postTranscriptionRequest,
  requireTranscriptionText,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  AIMLAPI_BASE_URL,
  DEFAULT_AIMLAPI_STT_MODEL,
  stripAimlApiProviderPrefix,
} from "./shared.js";

const PENDING_STT_STATUSES = new Set([
  "active",
  "pending",
  "processing",
  "queued",
  "running",
  "waiting",
]);
const COMPLETED_STT_STATUSES = new Set([
  "complete",
  "completed",
  "done",
  "finished",
  "success",
  "succeeded",
]);

type AimlApiTransport = "auto" | "json-url" | "multipart-file";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAimlApiAudioMime(mime?: string): string | undefined {
  const trimmed = mime?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)/);
  return match?.[1];
}

function normalizeAimlApiTransport(
  value: string | number | boolean | undefined,
): AimlApiTransport | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "json-url" || normalized === "multipart-file") {
    return normalized;
  }
  return undefined;
}

function resolveAimlApiTransport(params: AudioTranscriptionRequest): AimlApiTransport {
  const requested = normalizeAimlApiTransport(params.query?.transport);
  if (requested === "json-url" && params.sourceUrl?.trim()) {
    return "json-url";
  }
  if (requested === "multipart-file") {
    return "multipart-file";
  }
  if (params.sourceUrl?.trim()) {
    return "json-url";
  }
  return "multipart-file";
}

function buildAimlApiUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | number | boolean>,
): string {
  const url = new URL(`${baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === "transport") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function readObjectPath(payload: unknown, path: string[]): unknown {
  let current: unknown = payload;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractTranscriptFromCollection(items: unknown): string | undefined {
  if (!Array.isArray(items)) {
    return undefined;
  }
  const segments = items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      return firstNonEmptyString([
        record.text,
        record.transcript,
        readObjectPath(record, ["alternatives", "0", "transcript"]),
      ]);
    })
    .filter((value): value is string => Boolean(value));
  return segments.length > 0 ? segments.join(" ").trim() : undefined;
}

function extractAimlApiSttText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = firstNonEmptyString([
    record.text,
    record.transcript,
    readObjectPath(record, ["result", "transcript"]),
    readObjectPath(record, ["data", "transcript"]),
    readObjectPath(record, [
      "result",
      "results",
      "channels",
      "0",
      "alternatives",
      "0",
      "transcript",
    ]),
    readObjectPath(record, ["result", "results", "channels", "alternatives", "0", "transcript"]),
    readObjectPath(record, ["results", "channels", "0", "alternatives", "0", "transcript"]),
    readObjectPath(record, ["results", "channels", "alternatives", "0", "transcript"]),
  ]);
  if (direct) {
    return direct;
  }

  for (const key of ["paragraphs", "sentences", "segments"]) {
    const directCollection = extractTranscriptFromCollection(record[key]);
    if (directCollection) {
      return directCollection;
    }
  }

  for (const key of ["output", "result", "data", "results"]) {
    const nested = record[key];
    const nestedText = extractAimlApiSttText(nested);
    if (nestedText) {
      return nestedText;
    }
  }

  return undefined;
}

function extractAimlApiSttError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  const message = record.message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

export async function transcribeAimlApiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, AIMLAPI_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }
  const model = stripAimlApiProviderPrefix(params.model, DEFAULT_AIMLAPI_STT_MODEL);
  const transport = resolveAimlApiTransport(params);
  const createUrl = buildAimlApiUrl(baseUrl, "/stt/create", params.query);
  const createTimeoutMs = Math.min(params.timeoutMs, 30_000);
  const normalizedMime = normalizeAimlApiAudioMime(params.mime);
  const fileName = params.fileName?.trim() || "audio";
  const { response: createRes, release } =
    transport === "json-url"
      ? await (() => {
          const jsonHeaders = new Headers(headers);
          if (!jsonHeaders.has("content-type")) {
            jsonHeaders.set("content-type", "application/json");
          }
          return postJsonRequest({
            url: createUrl,
            headers: jsonHeaders,
            body: {
              model,
              url: params.sourceUrl?.trim(),
              ...(params.language?.trim() ? { language: params.language.trim() } : {}),
              ...(params.prompt?.trim() ? { prompt: params.prompt.trim() } : {}),
            },
            timeoutMs: createTimeoutMs,
            fetchFn,
            allowPrivateNetwork: allowPrivate,
          });
        })()
      : await (() => {
          const form = new FormData();
          const bytes = new Uint8Array(params.buffer);
          const blob = new Blob([bytes], {
            type: normalizedMime ?? "application/octet-stream",
          });
          form.append("file", blob, fileName);
          form.append("model", model);
          if (params.language?.trim()) {
            form.append("language", params.language.trim());
          }
          if (params.prompt?.trim()) {
            form.append("prompt", params.prompt.trim());
          }
          const multipartHeaders = new Headers(headers);
          multipartHeaders.delete("content-type");
          return postTranscriptionRequest({
            url: createUrl,
            headers: multipartHeaders,
            body: form,
            timeoutMs: createTimeoutMs,
            fetchFn,
            allowPrivateNetwork: allowPrivate,
          });
        })();

  try {
    await assertOkOrThrowHttpError(createRes, "AIMLAPI audio transcription failed");
    const createPayload = (await createRes.json()) as Record<string, unknown>;
    const immediateText = extractAimlApiSttText(createPayload);
    if (immediateText) {
      return {
        text: requireTranscriptionText(
          immediateText,
          "AIMLAPI audio transcription response missing text",
        ),
        model,
      };
    }

    const generationId =
      typeof createPayload.generation_id === "string" ? createPayload.generation_id.trim() : "";
    if (!generationId) {
      throw new Error("AIMLAPI audio transcription response missing generation_id.");
    }

    const deadline = Date.now() + params.timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1_000, deadline - Date.now());
      const pollRes = await fetchFn(
        buildAimlApiUrl(baseUrl, `/stt/${generationId}`, params.query),
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(Math.min(remainingMs, 15_000)),
        },
      );
      await assertOkOrThrowHttpError(pollRes, "AIMLAPI audio transcription polling failed");
      const pollPayload = (await pollRes.json()) as Record<string, unknown>;
      const text = extractAimlApiSttText(pollPayload);
      if (text) {
        return {
          text: requireTranscriptionText(text, "AIMLAPI audio transcription response missing text"),
          model,
        };
      }

      const status =
        typeof pollPayload.status === "string" ? pollPayload.status.trim().toLowerCase() : "";
      if (status && COMPLETED_STT_STATUSES.has(status)) {
        throw new Error("AIMLAPI audio transcription response parsed but transcript missing.");
      }
      if (status && !PENDING_STT_STATUSES.has(status)) {
        const detail = extractAimlApiSttError(pollPayload);
        throw new Error(
          detail
            ? `AIMLAPI audio transcription ended with status "${status}": ${detail}`
            : `AIMLAPI audio transcription ended with status "${status}" without text.`,
        );
      }
      await sleep(Math.min(2_000, remainingMs));
    }

    throw new Error(`AIMLAPI audio transcription pending timeout after ${params.timeoutMs}ms.`);
  } finally {
    await release();
  }
}

export const aimlapiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "aimlapi",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeAimlApiAudio,
};
