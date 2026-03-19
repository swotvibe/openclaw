import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { isAudioAttachment } from "./attachments.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import {
  type ActiveMediaModel,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.js";
import type {
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

function upsertOutput(
  existing: MediaUnderstandingOutput[] | undefined,
  next: MediaUnderstandingOutput,
): MediaUnderstandingOutput[] {
  const outputs = [...(existing ?? [])];
  const idx = outputs.findIndex(
    (entry) => entry.kind === next.kind && entry.attachmentIndex === next.attachmentIndex,
  );
  if (idx >= 0) {
    outputs[idx] = next;
    return outputs;
  }
  outputs.push(next);
  return outputs;
}

function upsertDecision(
  existing: MediaUnderstandingDecision[] | undefined,
  next: MediaUnderstandingDecision,
): MediaUnderstandingDecision[] {
  const decisions = [...(existing ?? [])];
  const nextIndexes = new Set(next.attachments.map((entry) => entry.attachmentIndex));
  const idx = decisions.findIndex(
    (entry) =>
      entry.capability === next.capability &&
      entry.attachments.some((attachment) => nextIndexes.has(attachment.attachmentIndex)),
  );
  if (idx >= 0) {
    decisions[idx] = next;
    return decisions;
  }
  decisions.push(next);
  return decisions;
}

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<string | undefined> {
  const { ctx, cfg } = params;

  const audioConfig = cfg.tools?.media?.audio;
  // Allow provider/key auto-detection even when tools.media.audio is absent.
  // Only an explicit disable should short-circuit preflight transcription.
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  // Find first audio attachment
  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  try {
    const { transcript, output, decision } = await runAudioTranscription({
      ctx,
      cfg,
      attachments,
      agentDir: params.agentDir,
      providers: params.providers,
      activeModel: params.activeModel,
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg, ctx }),
    });
    if (!transcript) {
      return undefined;
    }

    ctx.Transcript = transcript;
    if (output) {
      ctx.MediaUnderstanding = upsertOutput(ctx.MediaUnderstanding, output);
    }
    if (decision) {
      ctx.MediaUnderstandingDecisions = upsertDecision(ctx.MediaUnderstandingDecisions, decision);
    }

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return transcript;
  } catch (err) {
    // Log but don't throw - let the message proceed with text-only mention check
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  }
}
