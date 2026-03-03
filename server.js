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

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.get('/', (req, res) => {
  res.json({ status: 'Mentored backend is running', version: '2.0.0' });
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    const openaiKey = req.body.openaiKey;
    if (!openaiKey) return res.status(400).json({ error: 'Missing OpenAI API key' });
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const fileSizeMB = req.file.size / (1024 * 1024);
    console.log(`Received: ${req.file.originalname}, ${fileSizeMB.toFixed(1)}MB`);

    const LIMIT_MB = 24;
    let fullTranscript = '';

    if (fileSizeMB <= LIMIT_MB) {
      fullTranscript = await transcribeFile(filePath, req.file.originalname, openaiKey);
    } else {
      const chunkPaths = splitFileIntoChunks(filePath, LIMIT_MB);
      console.log(`Split into ${chunkPaths.length} chunks`);
      for (let i = 0; i < chunkPaths.length; i++) {
        console.log(`Transcribing chunk ${i+1}/${chunkPaths.length}`);
        const t = await transcribeFile(chunkPaths[i], `chunk_${i}.mp3`, openaiKey);
        fullTranscript += (i > 0 ? ' ' : '') + t;
        try { fs.unlinkSync(chunkPaths[i]); } catch(e) {}
      }
    }

    try { if (filePath) fs.unlinkSync(filePath); } catch(e) {}
    console.log(`Done. Transcript length: ${fullTranscript.length} chars`);
    res.json({ transcript: fullTranscript });

  } catch (err) {
    try { if (filePath) fs.unlinkSync(filePath); } catch(e) {}
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function transcribeFile(filePath, filename, openaiKey) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, ...form.getHeaders() },
    body: form
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`Whisper error (${response.status}): ${errData.error?.message || 'Check your OpenAI API key and billing.'}`);
  }
  const data = await response.json();
  return data.text || '';
}

function splitFileIntoChunks(filePath, chunkSizeMB) {
  const chunkSizeBytes = chunkSizeMB * 1024 * 1024;
  const fileBuffer = fs.readFileSync(filePath);
  const totalChunks = Math.ceil(fileBuffer.length / chunkSizeBytes);
  const chunkPaths = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSizeBytes;
    const end = Math.min(start + chunkSizeBytes, fileBuffer.length);
    const chunkPath = path.join(os.tmpdir(), `mentored_chunk_${Date.now()}_${i}.mp3`);
    fs.writeFileSync(chunkPath, fileBuffer.slice(start, end));
    chunkPaths.push(chunkPath);
  }
  return chunkPaths;
}

app.listen(PORT, () => console.log(`Mentored backend v2 running on port ${PORT}`));
