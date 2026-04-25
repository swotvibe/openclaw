import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/agent-runtime";
import type { ImageGenerationProvider as ImageGenerationProviderPlugin } from "openclaw/plugin-sdk/image-generation";
import {
  AIMLAPI_PROVIDER_ID,
  DEFAULT_AIMLAPI_IMAGE_MODEL,
  normalizeAimlApiOpenAiSurfaceModel,
  resolveAimlApiBaseUrl,
} from "./shared.js";

const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const AIMLAPI_SUPPORTED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;

type AimlApiImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
};

async function resolveImageBuffer(params: {
  entry: NonNullable<AimlApiImageApiResponse["data"]>[number];
  index: number;
}): Promise<{
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  revisedPrompt?: string;
}> {
  if (params.entry.b64_json) {
    return {
      buffer: Buffer.from(params.entry.b64_json, "base64"),
      mimeType: DEFAULT_OUTPUT_MIME,
      fileName: `image-${params.index + 1}.png`,
      ...(params.entry.revised_prompt ? { revisedPrompt: params.entry.revised_prompt } : {}),
    };
  }
  const imageUrl = params.entry.url?.trim();
  if (!imageUrl) {
    throw new Error("AIMLAPI image generation response entry is missing image content.");
  }
  const response = await fetch(imageUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `AIMLAPI image download failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() || DEFAULT_OUTPUT_MIME;
  const extension =
    contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: contentType,
    fileName: `image-${params.index + 1}.${extension}`,
    ...(params.entry.revised_prompt ? { revisedPrompt: params.entry.revised_prompt } : {}),
  };
}

export function buildAimlApiImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: AIMLAPI_PROVIDER_ID,
    label: "AIMLAPI",
    defaultModel: DEFAULT_AIMLAPI_IMAGE_MODEL,
    models: [DEFAULT_AIMLAPI_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...AIMLAPI_SUPPORTED_SIZES],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("AIMLAPI image generation provider does not support reference-image edits");
      }

      const auth = await resolveApiKeyForProvider({
        provider: AIMLAPI_PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });

      const response = await fetch(
        `${resolveAimlApiBaseUrl(req.cfg).replace(/\/+$/, "")}/images/generations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: normalizeAimlApiOpenAiSurfaceModel(req.model, DEFAULT_AIMLAPI_IMAGE_MODEL),
            prompt: req.prompt,
            n: req.count ?? 1,
            size: req.size ?? DEFAULT_SIZE,
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `AIMLAPI image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const data = (await response.json()) as AimlApiImageApiResponse;
      const images = await Promise.all(
        (data.data ?? []).map((entry, index) => resolveImageBuffer({ entry, index })),
      );

      return {
        images,
        model: normalizeAimlApiOpenAiSurfaceModel(req.model, DEFAULT_AIMLAPI_IMAGE_MODEL),
      };
    },
  };
}
