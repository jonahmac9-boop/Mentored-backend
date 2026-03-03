# Mentored Backend

Backend server for the Mentored Content Generator tool.

Handles audio transcription by:
1. Receiving MP3/WAV/M4A files from the browser
2. Splitting large files into chunks (handles files up to 250MB)
3. Sending each chunk to OpenAI Whisper
4. Returning the full stitched transcript

## Deploy on Render

1. Push this repo to GitHub
2. Go to render.com → New Web Service
3. Connect your GitHub repo
4. Render auto-detects the settings from render.yaml
5. Deploy

## Endpoints

`GET /` — Health check  
`POST /transcribe` — Transcribe audio file  
  - Body: multipart/form-data  
  - Fields: `audio` (file), `openaiKey` (string)  
  - Returns: `{ transcript: "..." }`
