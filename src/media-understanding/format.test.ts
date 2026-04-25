import { describe, expect, it } from "vitest";
import { formatAudioStatusSection, formatMediaUnderstandingBody } from "./format.js";

describe("formatMediaUnderstandingBody", () => {
  it("replaces placeholder body with transcript", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:audio>",
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "hello world",
          provider: "groq",
        },
      ],
    });
    expect(body).toBe("[Audio]\nTranscript:\nhello world");
  });

  it("includes user text when body is meaningful", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "transcribed",
          provider: "groq",
        },
      ],
    });
    expect(body).toBe("[Audio]\nUser text:\ncaption here\nTranscript:\ntranscribed");
  });

  it("strips leading media placeholders from user text", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:audio> caption here",
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "transcribed",
          provider: "groq",
        },
      ],
    });
    expect(body).toBe("[Audio]\nUser text:\ncaption here\nTranscript:\ntranscribed");
  });

  it("keeps user text once when multiple outputs exist", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "audio text",
          provider: "groq",
        },
        {
          kind: "video.description",
          attachmentIndex: 1,
          text: "video text",
          provider: "google",
        },
      ],
    });
    expect(body).toBe(
      [
        "User text:\ncaption here",
        "[Audio]\nTranscript:\naudio text",
        "[Video]\nDescription:\nvideo text",
      ].join("\n\n"),
    );
  });

  it("formats image outputs", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:image>",
      outputs: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "a cat",
          provider: "openai",
        },
      ],
    });
    expect(body).toBe("[Image]\nDescription:\na cat");
  });

  it("adds inline summary for a single long audio section", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:audio>",
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "full transcript",
          provider: "aimlapi",
        },
      ],
      audioContexts: new Map([
        [
          0,
          {
            transcript: "trimmed transcript",
            summary: "short summary",
          },
        ],
      ]),
    });

    expect(body).toBe("[Audio]\nSummary:\nshort summary\nTranscript:\ntrimmed transcript");
  });

  it("adds a shared summary block when multiple audio outputs are present", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "audio 1",
          provider: "aimlapi",
        },
        {
          kind: "audio.transcription",
          attachmentIndex: 1,
          text: "audio 2",
          provider: "aimlapi",
        },
      ],
      audioSummary: "shared summary",
      audioContexts: new Map([
        [0, { transcript: "trimmed 1" }],
        [1, { transcript: "trimmed 2" }],
      ]),
    });

    expect(body).toBe(
      [
        "User text:\ncaption here",
        "[Audio Summary]\nSummary:\nshared summary",
        "[Audio 1/2]\nTranscript:\ntrimmed 1",
        "[Audio 2/2]\nTranscript:\ntrimmed 2",
      ].join("\n\n"),
    );
  });
});

describe("formatAudioStatusSection", () => {
  it("includes user text when requested", () => {
    expect(
      formatAudioStatusSection({
        body: "<media:audio> caption here",
        status: "AIMLAPI transcription still processing",
        includeUserText: true,
      }),
    ).toBe(
      "[Audio Status]\nUser text:\ncaption here\nStatus:\nAIMLAPI transcription still processing",
    );
  });
});
