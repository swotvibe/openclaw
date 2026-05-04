import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "qwen",
  providerIds: ["qwen"],
  speechProviderIds: ["qwen"],
  realtimeVoiceProviderIds: ["qwen"],
  mediaUnderstandingProviderIds: ["qwen"],
  videoGenerationProviderIds: ["qwen"],
  requireSpeechVoices: true,
  requireDescribeImages: true,
  requireGenerateVideo: true,
});
