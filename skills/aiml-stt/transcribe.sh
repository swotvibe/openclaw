#!/bin/bash

# Configuration
API_KEY="a762d65e726041b6a45d92835baffa38"
API_URL="https://api.aimlapi.com/v1/stt"
MODEL="openai/gpt-4o-mini-transcribe"

INPUT_FILE="$1"

if [ -z "$INPUT_FILE" ]; then
  echo "Usage: $0 <audio_file>"
  exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: File not found: $INPUT_FILE"
  exit 1
fi

# Temp file for conversion
TEMP_WAV="/tmp/aiml_stt_$(date +%s).wav"

# Convert to WAV (16kHz mono recommended for STT, but default is fine)
# -y to overwrite, -ar 16000 -ac 1 for standard speech format
ffmpeg -i "$INPUT_FILE" -ar 16000 -ac 1 -y "$TEMP_WAV" -v error

# Upload and Create Job
# Note: aimlapi is strict about mime type, so we force it for the wav file
RESPONSE=$(curl -s -X POST "$API_URL/create" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@$TEMP_WAV;type=audio/wav" \
  -F "model=$MODEL")

# Extract Generation ID (using grep/sed because jq might not be there, though it usually is)
# Assuming simple json structure: {"generation_id":"..."}
GEN_ID=$(echo "$RESPONSE" | grep -o '"generation_id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$GEN_ID" ]; then
  echo "Error: Failed to create job."
  echo "Response: $RESPONSE"
  rm "$TEMP_WAV"
  exit 1
fi

echo "Job started. ID: $GEN_ID"

# Poll for completion
STATUS="queued"
while [[ "$STATUS" != "completed" && "$STATUS" != "failed" ]]; do
  sleep 2
  POLL_RESPONSE=$(curl -s -X GET "$API_URL/$GEN_ID" \
    -H "Authorization: Bearer $API_KEY")
  
  STATUS=$(echo "$POLL_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  
  if [ "$STATUS" == "failed" ]; then
    echo "Error: Transcription failed."
    echo "Response: $POLL_RESPONSE"
    rm "$TEMP_WAV"
    exit 1
  fi
done

# Extract Text
TRANSCRIPT=$(echo "$POLL_RESPONSE" | sed 's/.*"text":"\([^"]*\)".*/\1/')
# Decode unicode escape sequences if any (python one-liner is reliable)
CLEAN_TEXT=$(echo "$TRANSCRIPT" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read().strip()))" | sed 's/^"//;s/"$//')

# If python decode fails or is overkill, just output the raw transcript from regex
# But let's try a simpler grep that handles the json better if jq is installed.
# Checking for jq:
if command -v jq &> /dev/null; then
    CLEAN_TEXT=$(echo "$POLL_RESPONSE" | jq -r '.result.text')
else
    # Fallback regex (simple)
    CLEAN_TEXT=$TRANSCRIPT
fi

echo "Transcription:"
echo "$CLEAN_TEXT"

# Cleanup
rm "$TEMP_WAV"
