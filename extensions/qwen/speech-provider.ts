import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { trimToUndefined, type SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { QWEN_STANDARD_CN_BASE_URL, QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const PROVIDER_ID = "qwen";
const DEFAULT_OMNI_MODEL = "qwen3.5-omni-flash";
const DEFAULT_VOICE = "Chelsie";
const SAMPLE_RATE = 24_000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const ENV_API_KEY_VARS = ["QWEN_API_KEY", "MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY"] as const;

function resolveEnvApiKey(): string | undefined {
  for (const v of ENV_API_KEY_VARS) {
    const key = process.env[v]?.trim();
    if (key) {
      return key;
    }
  }
  return undefined;
}

const QWEN_OMNI_VOICES = ["Chelsie", "Cherry", "Ethan", "Serena", "Tina"] as const;

type QwenTtsConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
};

function resolveQwenStandardBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string {
  const direct = cfg?.models?.providers?.qwen?.baseUrl?.trim();
  if (!direct) {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
  try {
    const url = new URL(direct);
    if (
      url.hostname === "coding.dashscope.aliyuncs.com" ||
      url.hostname === "dashscope.aliyuncs.com"
    ) {
      return QWEN_STANDARD_CN_BASE_URL;
    }
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  } catch {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
}

function readQwenTtsConfig(
  providerConfig: Record<string, unknown>,
  cfg?: Record<string, unknown>,
): QwenTtsConfig {
  return {
    apiKey: trimToUndefined(providerConfig.apiKey),
    baseUrl:
      trimToUndefined(providerConfig.baseUrl) ??
      resolveQwenStandardBaseUrl(cfg as Parameters<typeof resolveQwenStandardBaseUrl>[0]),
    model: trimToUndefined(providerConfig.model) ?? DEFAULT_OMNI_MODEL,
    voice: trimToUndefined(providerConfig.voice) ?? DEFAULT_VOICE,
  };
}

function createWavBuffer(pcmData: Buffer): Buffer {
  const dataSize = pcmData.length;
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

type StreamChunkChoice = {
  delta?: {
    content?: string;
    audio?: { data?: string };
  };
};

type StreamChunk = {
  choices?: StreamChunkChoice[];
};

async function streamQwenOmniAudio(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<Buffer> {
  const fetchFn = params.fetchFn ?? fetch;
  const url = `${params.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: "user", content: params.text }],
      modalities: ["text", "audio"],
      audio: { voice: params.voice, format: "wav" },
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Qwen Omni TTS failed (${response.status}): ${errorText || response.statusText}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Qwen Omni TTS: no response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const audioChunks: string[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

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
          const audioData = chunk.choices?.[0]?.delta?.audio?.data;
          if (audioData) {
            audioChunks.push(audioData);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (audioChunks.length === 0) {
    throw new Error("Qwen Omni TTS: no audio data in response");
  }

  const pcmData = Buffer.from(audioChunks.join(""), "base64");
  return createWavBuffer(pcmData);
}

export function buildQwenSpeechProvider(): SpeechProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Qwen Omni",
    models: [DEFAULT_OMNI_MODEL],
    voices: [...QWEN_OMNI_VOICES],
    autoSelectOrder: 40,
    resolveConfig: ({ cfg, rawConfig }) => {
      const baseUrl = resolveQwenStandardBaseUrl(
        cfg as Parameters<typeof resolveQwenStandardBaseUrl>[0],
      );
      const providers =
        typeof rawConfig.providers === "object" && rawConfig.providers !== null
          ? (rawConfig.providers as Record<string, unknown>)
          : {};
      const qwenRaw =
        typeof providers.qwen === "object" && providers.qwen !== null
          ? (providers.qwen as Record<string, unknown>)
          : {};
      return {
        apiKey: trimToUndefined(qwenRaw.apiKey),
        baseUrl: trimToUndefined(qwenRaw.baseUrl) ?? baseUrl,
        model: trimToUndefined(qwenRaw.model) ?? DEFAULT_OMNI_MODEL,
        voice: trimToUndefined(qwenRaw.voice) ?? DEFAULT_VOICE,
      };
    },
    listVoices: async () => QWEN_OMNI_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ providerConfig }) =>
      Boolean(trimToUndefined(providerConfig.apiKey) || resolveEnvApiKey()),
    synthesize: async (req) => {
      const config = readQwenTtsConfig(
        req.providerConfig,
        req.cfg as unknown as Record<string, unknown>,
      );
      const overrideVoice = trimToUndefined(req.providerOverrides?.voice);
      const overrideModel = trimToUndefined(req.providerOverrides?.model);

      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
      });
      const apiKey = config.apiKey || auth.apiKey || resolveEnvApiKey();
      if (!apiKey) {
        throw new Error("Qwen API key missing for TTS");
      }

      const audioBuffer = await streamQwenOmniAudio({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrideModel ?? config.model,
        voice: overrideVoice ?? config.voice,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      };
    },
  };
}
