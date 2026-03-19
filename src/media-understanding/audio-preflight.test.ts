import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  runAudioTranscription: vi.fn(),
  normalizeMediaAttachments: vi.fn(),
  resolveMediaAttachmentLocalRoots: vi.fn(() => []),
}));

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: mocks.runAudioTranscription,
}));

vi.mock("./runner.js", () => ({
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots: mocks.resolveMediaAttachmentLocalRoots,
}));

import { transcribeFirstAudio } from "./audio-preflight.js";

describe("transcribeFirstAudio", () => {
  beforeEach(() => {
    mocks.runAudioTranscription.mockReset();
    mocks.normalizeMediaAttachments.mockReset();
    mocks.resolveMediaAttachmentLocalRoots.mockClear();
  });

  it("uses the auto-detect fallback path when audio config is absent", async () => {
    const ctx = {} as MsgContext;
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/voice.ogg", mime: "audio/ogg" },
    ]);
    mocks.runAudioTranscription.mockResolvedValue({
      transcript: "voice fallback transcript",
      output: {
        kind: "audio.transcription",
        attachmentIndex: 0,
        text: "voice fallback transcript",
        provider: "aimlapi",
      },
      decision: {
        capability: "audio",
        outcome: "success",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [{ type: "provider", provider: "aimlapi", outcome: "success" }],
            chosen: { type: "provider", provider: "aimlapi", outcome: "success" },
          },
        ],
      },
      attachments: [{ index: 0, path: "/tmp/voice.ogg", mime: "audio/ogg" }],
    });

    const transcript = await transcribeFirstAudio({
      ctx,
      cfg: {} as OpenClawConfig,
    });

    expect(transcript).toBe("voice fallback transcript");
    expect(ctx.Transcript).toBe("voice fallback transcript");
    expect(ctx.MediaUnderstanding?.[0]).toMatchObject({
      kind: "audio.transcription",
      attachmentIndex: 0,
      text: "voice fallback transcript",
    });
    expect(ctx.MediaUnderstandingDecisions?.[0]?.capability).toBe("audio");
    expect(mocks.runAudioTranscription).toHaveBeenCalledTimes(1);
  });

  it("stays disabled only when audio understanding is explicitly disabled", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/voice.ogg", mime: "audio/ogg" },
    ]);

    const transcript = await transcribeFirstAudio({
      ctx: {} as MsgContext,
      cfg: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(transcript).toBeUndefined();
    expect(mocks.runAudioTranscription).not.toHaveBeenCalled();
  });
});
