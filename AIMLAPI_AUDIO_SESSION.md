# AIMLAPI Audio And Integration Session Notes

Generated: 2026-03-19 UTC

## Purpose

This file documents the full AIMLAPI integration and audio-debugging session that happened in this workspace.
It is an internal engineering note, not public product documentation.

Sensitive values that appeared during debugging, such as API keys, gateway tokens, and channel tokens, are intentionally redacted here.

## Executive Summary

This session covered three related workstreams:

1. Stabilizing AIMLAPI as an OpenClaw provider for chat and agent execution.
2. Designing and implementing first-party AIMLAPI support across multiple surfaces with one key.
3. Diagnosing why voice notes were not understood, then implementing the OpenClaw-side fixes for audio transcription context handling.

The final state at the end of this session was:

- AIMLAPI chat/provider integration was functioning for agent chat paths.
- OpenClaw audio handling was improved substantially:
  - preflight transcription writes into message context,
  - apply-time media handling reuses existing transcription output,
  - long voice notes can be summarized into agent context,
  - audio failure states are surfaced explicitly instead of silently degrading to raw attachments.
- A critical live discovery corrected one planning assumption:
  - `POST /v1/stt/create` on AIMLAPI expects `file` or `url`,
  - not `audio`.
- After correcting that field name, AIMLAPI accepted the uploaded OGG/Opus file and returned a `generation_id`,
  but the sampled polls still remained `queued`.

That means the OpenClaw side is now materially better and more diagnosable, but seamless STT on AIMLAPI alone is still not guaranteed until AIMLAPI completes queued jobs reliably for this file class or a fallback provider is added in a later iteration.

## High-Level Timeline

### 1. Initial AIMLAPI Provider Configuration

The session started from an AIMLAPI integration summary that established:

- provider base URL: `https://api.aimlapi.com/v1`
- model refs must use the full AIMLAPI model name
- `agents.defaults.model.primary` must point at the full provider/model ref
- runtime issues could appear as:
  - `HTTP 404: Model not found`
  - `HTTP 400: Invalid payload provided`

Early chat-path debugging established:

- `google/gemini-3-pro-preview` needed the full AIMLAPI model id
- the chat integration worked correctly only after using the proper OpenAI-compatible surface for the model
- AIMLAPI chat issues were distinct from later filesystem/runtime issues

### 2. Runtime And Gateway Recovery

The session then uncovered several operational issues unrelated to audio:

- `EACCES: permission denied, mkdir '/home/ubuntu'`
- stale state pointing at `/home/node`
- a runtime mismatch between the checked-out repo and the active `/opt/openclaw` runtime
- a conflicting Docker gateway on the same port

The end result of that debugging was:

- `/opt/openclaw` was aligned to the intended runtime
- the conflicting Docker gateway was stopped
- the gateway health path and `agent --agent main` path were revalidated
- later `EACCES` was treated as historical or environmental, not the active root cause for the audio problem

### 3. Audio Symptom

The user then reported that a voice message was attached but not understood by the agent.

Observed symptom:

- the agent saw a raw attachment marker like `[media attached: ...ogg]`
- no transcript appeared in the effective agent context

That meant the voice note was reaching OpenClaw as media, but not becoming usable text for the agent turn.

## Root Cause Analysis For Audio

The audio investigation identified multiple layers:

### Layer A: Configuration / Activation

Initially, the active config had AIMLAPI for chat, but not a sufficiently reliable audio path.

Important config fact:

- `tools.media.audio` is the surface that controls STT for media understanding

### Layer B: OpenClaw Context Flow

The earlier behavior had a weak spot:

- audio preflight could transcribe for mention/command gating,
  but that result was not strongly persisted into the broader context flow
- later apply-time media handling could re-run or lose track of the earlier result
- when transcription did not arrive in time, the agent effectively received only a raw media marker

### Layer C: AIMLAPI Speech Behavior

Live behavior against AIMLAPI showed two separate facts:

1. the field name assumption in the original plan was wrong
2. even after using the correct upload field, the STT job still remained queued during sampled polling

## Plans Discussed During The Session

Several plans were proposed and refined during the conversation:

### AIMLAPI As A First-Party One-Key Provider

The session defined a broader direction for AIMLAPI:

- first-party provider id: `aimlapi`
- one API key for:
  - chat / vision
  - transcription
  - TTS
  - image generation
  - embeddings
- model discovery from AIMLAPI
- deterministic endpoint selection instead of silent runtime fallback
- diagnostic hints for:
  - model not found
  - wrong endpoint
  - surface mismatch

### Audio-Specific Plan

The audio plan was later refined to focus on:

- a single AIMLAPI STT flow for v1
- no `ffmpeg`
- no provider fallback in v1
- transcript reuse between preflight and apply
- summary-first context for long audio
- explicit `[Audio Status]` surfacing on failure or timeout

One assumption in that plan was later corrected by live verification:

- the plan assumed `multipart` field name `audio`
- live testing proved AIMLAPI expects `file` on `/v1/stt/create`

## What Was Implemented

### 1. AIMLAPI Audio Transport And Parsing

Updated in `extensions/aimlapi/media-understanding-provider.ts`.

Implemented:

- transport selection between:
  - JSON `{ url }` mode for true remote URLs
  - multipart upload mode for local files / buffers
- explicit use of `POST /v1/stt/create`
- broader pending status support:
  - `waiting`
  - `active`
  - `queued`
  - `pending`
  - `processing`
  - `running`
- broader completed status support
- broader transcript extraction from nested response shapes
- MIME normalization such as:
  - `audio/ogg; codecs=opus` -> `audio/ogg`

Final correction from live verification:

- multipart upload field was changed to `file`
- not `audio`

Relevant file:

- `extensions/aimlapi/media-understanding-provider.ts`

### 2. Preflight / Apply De-Duplication

Updated in:

- `src/media-understanding/audio-preflight.ts`
- `src/media-understanding/audio-transcription-runner.ts`
- `src/media-understanding/apply.ts`
- `src/media-understanding/runner.entries.ts`
- `src/media-understanding/runner.ts`
- `src/media-understanding/types.ts`

Implemented:

- audio preflight now stores successful transcription directly into context
- media understanding outputs are upserted instead of being treated as disposable temporary state
- apply-time media handling marks already-transcribed attachments and reuses them
- the same attachment is no longer intended to be retranscribed in the same turn flow

### 3. Audio Context Shaping

Updated in:

- `src/media-understanding/apply.ts`
- `src/media-understanding/format.ts`
- `src/media-understanding/audio-summary.ts`
- `src/media-understanding/defaults.ts`

Implemented:

- new summary-first audio context behavior
- full transcript stored in context
- clipped inline transcript for long audio in the prompt body
- optional one-pass summary generation using the active resolved model
- a dedicated `[Audio Status]` block when transcription does not complete or fails

### 4. New Audio Config Surface

Updated in:

- `src/config/types.tools.ts`
- `src/config/zod-schema.core.ts`
- `src/config/media-audio-field-metadata.ts`
- `src/media-understanding/defaults.ts`

Added config keys:

- `tools.media.audio.contextMode`
- `tools.media.audio.summaryTriggerChars`
- `tools.media.audio.inlineTranscriptMaxChars`
- `tools.media.audio.summaryMaxTokens`

Defaults chosen in this session:

- `contextMode = "transcript+summary"`
- `summaryTriggerChars = 1000`
- `inlineTranscriptMaxChars = 4000`
- `summaryMaxTokens = 180`

## Tests Added Or Updated

### AIMLAPI Audio Provider Test

`extensions/aimlapi/media-understanding-provider.test.ts`

Covers:

- multipart upload path
- correct field name behavior
- URL-only JSON path
- pending status handling
- nested transcript extraction
- pending timeout behavior

### OpenClaw Media Flow Tests

Updated or added:

- `src/media-understanding/audio-preflight.test.ts`
- `src/media-understanding/format.test.ts`
- `src/media-understanding/apply.test.ts`
- `src/config/config.schema-regressions.test.ts`
- `src/media-understanding/defaults.test.ts`

Covers:

- preflight transcript persistence
- summary-first prompt shaping
- transcript clipping
- explicit audio failure surfacing
- schema acceptance of the new audio config fields
- new default values

## Verification Performed

### Local / Build Verification

Successful checks during the session:

- targeted unit tests for:
  - `src/media-understanding/audio-preflight.test.ts`
  - `src/media-understanding/format.test.ts`
  - `src/media-understanding/apply.test.ts`
  - `src/config/config.schema-regressions.test.ts`
  - `src/media-understanding/defaults.test.ts`
- targeted extension test for:
  - `extensions/aimlapi/media-understanding-provider.test.ts`
- full `pnpm build`

Environment used:

- Node `v24.14.0`
- pnpm `10.23.0`

### Note About Test Harness Behavior

At one point, grouped `pnpm test -- ...` runs appeared to hang in this environment.
Running the relevant test files individually through Vitest config entrypoints succeeded and provided reliable confirmation of the modified paths.

This was treated as an environment/test-runner issue, not as an assertion failure in the modified audio code.

## Live AIMLAPI Verification Findings

The most important live verification results were:

### Attempt 1: Multipart With `audio`

Direct request:

- `POST /v1/stt/create`
- multipart field: `audio`

Result:

- `HTTP 400 Invalid payload provided`
- provider message indicated:
  - `One of url or file is required`

Conclusion:

- `audio` is not the correct multipart field name for this endpoint in the observed live behavior

### Attempt 2: Multipart With `file`

Direct request:

- `POST /v1/stt/create`
- multipart field: `file`

Result:

- accepted
- response contained:
  - `generation_id`
  - `status: queued`

Conclusion:

- `file` is the correct multipart upload field for AIMLAPI STT on this endpoint

### Polling Result

Subsequent polling of:

- `GET /v1/stt/{generation_id}`

Observed:

- repeated `status: queued`
- no transcript returned during the sampled polling window

Conclusion:

- OpenClaw can now submit the job correctly
- the remaining limitation for this sample is AIMLAPI job completion latency or queue behavior

## Final Technical Conclusions

### What Is Fixed

- The OpenClaw-side audio flow is materially improved.
- Voice note handling no longer depends on a fragile temporary preflight path.
- Long audio can be summarized into cleaner agent context.
- Failed or incomplete transcription now surfaces an explicit status block instead of silently degrading to raw media-only context.
- AIMLAPI multipart upload path for STT is now using the correct live-verified field name: `file`.

### What Is Not Guaranteed Yet

- Successful, timely transcript delivery from AIMLAPI for every uploaded OGG/Opus voice note is still not guaranteed.
- In the tested live sample, AIMLAPI accepted the upload but remained `queued`.

### Product-Level Implication

The user experience is better than before because:

- the agent gets clearer context when transcription succeeds
- the agent gets an explicit audio-status signal when transcription does not complete

But true seamless STT still depends on one of the following:

1. AIMLAPI improving completion behavior for these uploads
2. a v2 fallback chain to another STT provider
3. background job resume / delayed transcript reinjection in a later design

## Recommended Next Steps

### V1 Follow-Up

- keep the current OpenClaw-side fixes
- ship the corrected `file` transport
- keep explicit failure surfacing enabled

### V2 Options

- add ordered fallback providers for STT
- add background resume based on `generation_id`
- add provider-specific heuristics if AIMLAPI exposes more reliable queue semantics later

## Files Most Relevant To This Session

Primary implementation files:

- `extensions/aimlapi/media-understanding-provider.ts`
- `src/media-understanding/audio-preflight.ts`
- `src/media-understanding/audio-transcription-runner.ts`
- `src/media-understanding/apply.ts`
- `src/media-understanding/format.ts`
- `src/media-understanding/audio-summary.ts`
- `src/media-understanding/defaults.ts`
- `src/config/types.tools.ts`
- `src/config/zod-schema.core.ts`
- `src/config/media-audio-field-metadata.ts`

Primary test files:

- `extensions/aimlapi/media-understanding-provider.test.ts`
- `src/media-understanding/audio-preflight.test.ts`
- `src/media-understanding/format.test.ts`
- `src/media-understanding/apply.test.ts`
- `src/config/config.schema-regressions.test.ts`
- `src/media-understanding/defaults.test.ts`

## Closing Status

At the end of this session:

- code changes were in place
- targeted tests passed
- build passed
- live AIMLAPI verification proved the correct multipart field name is `file`
- live AIMLAPI verification also showed that the tested transcription job still remained `queued`

That is the final verified state captured by this conversation.
