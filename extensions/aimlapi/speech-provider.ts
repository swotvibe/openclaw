import {
  ensureAuthProfileStore,
  hasUsableCustomProviderApiKey,
  listProfilesForProvider,
  OPENAI_TTS_VOICES,
  resolveApiKeyForProvider,
  resolveEnvApiKey,
} from "openclaw/plugin-sdk/agent-runtime";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/core";
import { resolveOpenAITtsInstructions } from "openclaw/plugin-sdk/voice-call";
import {
  AIMLAPI_PROVIDER_ID,
  DEFAULT_AIMLAPI_TTS_MODEL,
  normalizeAimlApiOpenAiSurfaceModel,
  resolveAimlApiBaseUrl,
} from "./shared.js";

const AIMLAPI_TTS_MODELS = ["openai/gpt-4o-mini-tts", "openai/tts-1", "openai/tts-1-hd"] as const;

type AimlApiTtsResponse = {
  audio?: {
    url?: string;
  };
};

function hasAimlApiAuthProfile(): boolean {
  return listProfilesForProvider(ensureAuthProfileStore(), AIMLAPI_PROVIDER_ID).length > 0;
}

export function buildAimlApiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: AIMLAPI_PROVIDER_ID,
    label: "AIMLAPI",
    models: AIMLAPI_TTS_MODELS,
    voices: OPENAI_TTS_VOICES,
    listVoices: async () => OPENAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ cfg }) =>
      hasUsableCustomProviderApiKey(cfg, AIMLAPI_PROVIDER_ID) ||
      Boolean(resolveEnvApiKey(AIMLAPI_PROVIDER_ID)) ||
      hasAimlApiAuthProfile(),
    synthesize: async (req) => {
      const auth = await resolveApiKeyForProvider({
        provider: AIMLAPI_PROVIDER_ID,
        cfg: req.cfg,
      });
      const responseFormat = req.target === "voice-note" ? "opus" : "mp3";
      const model = normalizeAimlApiOpenAiSurfaceModel(
        req.overrides?.openai?.model ?? req.config.openai.model,
        DEFAULT_AIMLAPI_TTS_MODEL,
      );
      const voice = req.overrides?.openai?.voice ?? req.config.openai.voice;
      const instructions = resolveOpenAITtsInstructions(model, req.config.openai.instructions);
      const baseUrl = resolveAimlApiBaseUrl(req.cfg).replace(/\/+$/, "");

      const response = await fetch(`${baseUrl}/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          text: req.text,
          voice,
          response_format: responseFormat,
          ...(typeof req.config.openai.speed === "number"
            ? { speed: req.config.openai.speed }
            : {}),
          ...(instructions ? { instructions } : {}),
        }),
        signal: AbortSignal.timeout(req.config.timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`AIMLAPI TTS failed (${response.status}): ${text || response.statusText}`);
      }

      const payload = (await response.json()) as AimlApiTtsResponse;
      const audioUrl = payload.audio?.url?.trim();
      if (!audioUrl) {
        throw new Error("AIMLAPI TTS response missing audio.url");
      }

      const audioResponse = await fetch(audioUrl, {
        signal: AbortSignal.timeout(req.config.timeoutMs),
      });
      if (!audioResponse.ok) {
        const text = await audioResponse.text().catch(() => "");
        throw new Error(
          `AIMLAPI TTS audio download failed (${audioResponse.status}): ${text || audioResponse.statusText}`,
        );
      }

      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: responseFormat === "opus" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
  };
}
