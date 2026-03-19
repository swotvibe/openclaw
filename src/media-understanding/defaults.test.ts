import { describe, expect, it } from "vitest";
import {
  AUTO_AUDIO_KEY_PROVIDERS,
  AUTO_IMAGE_KEY_PROVIDERS,
  AUTO_VIDEO_KEY_PROVIDERS,
  DEFAULT_AUDIO_CONTEXT_MODE,
  DEFAULT_AUDIO_INLINE_TRANSCRIPT_MAX_CHARS,
  DEFAULT_AUDIO_MODELS,
  DEFAULT_AUDIO_SUMMARY_MAX_TOKENS,
  DEFAULT_AUDIO_SUMMARY_TRIGGER_CHARS,
  DEFAULT_IMAGE_MODELS,
} from "./defaults.js";

describe("DEFAULT_AUDIO_MODELS", () => {
  it("includes Mistral Voxtral default", () => {
    expect(DEFAULT_AUDIO_MODELS.mistral).toBe("voxtral-mini-latest");
  });

  it("includes AIMLAPI transcription default", () => {
    expect(DEFAULT_AUDIO_MODELS.aimlapi).toBe("openai/gpt-4o-mini-transcribe");
  });
});

describe("audio context defaults", () => {
  it("uses transcript+summary mode by default", () => {
    expect(DEFAULT_AUDIO_CONTEXT_MODE).toBe("transcript+summary");
    expect(DEFAULT_AUDIO_SUMMARY_TRIGGER_CHARS).toBe(1000);
    expect(DEFAULT_AUDIO_INLINE_TRANSCRIPT_MAX_CHARS).toBe(4000);
    expect(DEFAULT_AUDIO_SUMMARY_MAX_TOKENS).toBe(180);
  });
});

describe("AUTO_AUDIO_KEY_PROVIDERS", () => {
  it("includes mistral auto key resolution", () => {
    expect(AUTO_AUDIO_KEY_PROVIDERS).toContain("mistral");
  });

  it("includes AIMLAPI auto key resolution", () => {
    expect(AUTO_AUDIO_KEY_PROVIDERS).toContain("aimlapi");
  });
});

describe("AUTO_VIDEO_KEY_PROVIDERS", () => {
  it("includes moonshot auto key resolution", () => {
    expect(AUTO_VIDEO_KEY_PROVIDERS).toContain("moonshot");
  });
});

describe("AUTO_IMAGE_KEY_PROVIDERS", () => {
  it("includes minimax-portal auto key resolution", () => {
    expect(AUTO_IMAGE_KEY_PROVIDERS).toContain("minimax-portal");
  });

  it("includes AIMLAPI auto key resolution", () => {
    expect(AUTO_IMAGE_KEY_PROVIDERS).toContain("aimlapi");
  });
});

describe("DEFAULT_IMAGE_MODELS", () => {
  it("includes the MiniMax portal vision default", () => {
    expect(DEFAULT_IMAGE_MODELS["minimax-portal"]).toBe("MiniMax-VL-01");
  });

  it("includes the AIMLAPI vision default", () => {
    expect(DEFAULT_IMAGE_MODELS.aimlapi).toBe("google/gemini-3-pro-preview");
  });
});
