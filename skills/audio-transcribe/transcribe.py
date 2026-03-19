import sys
import whisper
import warnings

# Suppress warnings
warnings.filterwarnings("ignore")

def transcribe(file_path):
    try:
        # Load the model (using "base" for speed/accuracy balance)
        model = whisper.load_model("base")
        
        # Transcribe
        result = model.transcribe(file_path)
        print(f"Transcription: {result['text']}")
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <audio_file>")
        sys.exit(1)
        
    audio_file = sys.argv[1]
    transcribe(audio_file)
