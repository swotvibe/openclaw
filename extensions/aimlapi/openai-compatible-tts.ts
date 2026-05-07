export const OPENAI_COMPATIBLE_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

export function resolveOpenAiCompatibleTtsInstructions(
  model: string,
  instructions?: string,
): string | undefined {
  const next = instructions?.trim();
  return next && model.includes("gpt-4o-mini-tts") ? next : undefined;
}
