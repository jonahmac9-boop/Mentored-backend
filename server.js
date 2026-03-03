const express = require('express');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow requests from any origin (Netlify, localhost, etc) ──
app.use(cors());
app.use(express.json());

// ── File upload — store in temp directory ──
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 250 * 1024 * 1024 } // 250MB max
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'Mentored backend is running', version: '1.0.0' });
});

// ── TRANSCRIBE endpoint ──
// Accepts: multipart form with 'audio' file and 'openaiKey' field
// Returns: { transcript: "..." }
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    const openaiKey = req.body.openaiKey;
    if (!openaiKey) {
      return res.status(400).json({ error: 'Missing OpenAI API key' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const fileSizeBytes = req.file.size;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);
    const CHUNK_SIZE_MB = 20; // Stay safely under OpenAI's 25MB limit

    let fullTranscript = '';

    if (fileSizeMB <= CHUNK_SIZE_MB) {
      // ── Small file — send directly ──
      fullTranscript = await transcribeChunk(filePath, req.file.originalname, openaiKey);
    } else {
      // ── Large file — split into chunks using ffmpeg ──
      const chunkDuration = estimateChunkDuration(fileSizeBytes);
      const chunks = await splitAudio(filePath, chunkDuration);

      for (let i = 0; i < chunks.length; i++) {
        const chunkTranscript = await transcribeChunk(chunks[i], `chunk_${i}.mp3`, openaiKey);
        fullTranscript += (i > 0 ? ' ' : '') + chunkTranscript;
        // Clean up chunk
        try { fs.unlinkSync(chunks[i]); } catch(e) {}
      }
    }

    // Clean up original upload
    try { if (filePath) fs.unlinkSync(filePath); } catch(e) {}

    res.json({ transcript: fullTranscript });

  } catch (err) {
    // Clean up on error
    try { if (filePath) fs.unlinkSync(filePath); } catch(e) {}
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Send a single file chunk to OpenAI Whisper ──
async function transcribeChunk(filePath, filename, openaiKey) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      ...form.getHeaders()
    },
    body: form
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`OpenAI Whisper error (${response.status}): ${errData.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  return data.text || '';
}

// ── Estimate chunk duration in seconds based on file size ──
// Targets ~20MB chunks. Assumes ~128kbps MP3.
function estimateChunkDuration(fileSizeBytes) {
  const bitrateKbps = 128;
  const totalSeconds = (fileSizeBytes * 8) / (bitrateKbps * 1000);
  const targetChunkSizeBytes = 20 * 1024 * 1024;
  const chunkDuration = (targetChunkSizeBytes * 8) / (bitrateKbps * 1000);
  return Math.floor(Math.min(chunkDuration, totalSeconds));
}

// ── Split audio file into chunks using ffmpeg ──
function splitAudio(inputPath, chunkDurationSeconds) {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('fluent-ffmpeg');

    // Get total duration first
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

      const totalDuration = metadata.format.duration;
      const chunks = [];
      const promises = [];

      let startTime = 0;
      let chunkIndex = 0;

      while (startTime < totalDuration) {
        const chunkPath = path.join(os.tmpdir(), `mentored_chunk_${Date.now()}_${chunkIndex}.mp3`);
        const duration = Math.min(chunkDurationSeconds, totalDuration - startTime);
        const start = startTime;

        const promise = new Promise((res, rej) => {
          ffmpeg(inputPath)
            .setStartTime(start)
            .setDuration(duration)
            .output(chunkPath)
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .on('end', () => res(chunkPath))
            .on('error', (e) => rej(new Error(`ffmpeg chunk error: ${e.message}`)))
            .run();
        });

        chunks.push({ index: chunkIndex, path: chunkPath });
        promises.push(promise);
        startTime += chunkDurationSeconds;
        chunkIndex++;
      }

      Promise.all(promises)
        .then(() => resolve(chunks.map(c => c.path)))
        .catch(reject);
    });
  });
}

app.listen(PORT, () => {
  console.log(`Mentored backend running on port ${PORT}`);
});
