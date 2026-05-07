---
name: aiml-stt
description: Transcribe audio files using AIMLAPI (Cloud STT). Supports most audio formats by converting to wav first. Use this for high-accuracy transcription via the cloud.
**UX Rule**: Reply with "جاري التحليل... 🎙️⏳" immediately, then call the script. After getting the text, act on it without repeating the text.
---

# AIML Cloud STT

Uses AIMLAPI (OpenAI-compatible) to transcribe audio.

## Usage

```bash
~/opt/openclaw/skills/aiml-stt/transcribe.sh <path_to_audio_file>
```

## Requirements

- `ffmpeg` (installed)
- `curl` (installed)
- API Key (embedded in script)
