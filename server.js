const express = require('express');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory job store
// job: { id, status: 'queued'|'processing'|'done'|'error', transcript, error, createdAt }
const jobs = {};

// Clean up old jobs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const id in jobs) {
    if (jobs[id].createdAt < cutoff) delete jobs[id];
  }
}, 30 * 60 * 1000);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 250 * 1024 * 1024 }
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'Mentored backend v3 running', version: '3.0.0' });
});

// ── Keepalive ping ──
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: Date.now() });
});

// ── SUBMIT job ──
// Browser sends file here, gets a job ID back immediately
app.post('/transcribe/submit', upload.single('audio'), (req, res) => {
  try {
    const openaiKey = req.body.openaiKey;
    if (!openaiKey) return res.status(400).json({ error: 'Missing OpenAI API key' });
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const jobId = uuidv4();
    jobs[jobId] = {
      id: jobId,
      status: 'queued',
      transcript: null,
      error: null,
      createdAt: Date.now()
    };

    const fileSizeMB = req.file.size / (1024 * 1024);
    console.log(`Job ${jobId} queued: ${req.file.originalname}, ${fileSizeMB.toFixed(1)}MB`);

    // Respond immediately with job ID
    res.json({ jobId });

    // Process in background — no await, intentionally fire-and-forget
    processJob(jobId, req.file.path, req.file.originalname, openaiKey);

  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POLL job status ──
// Browser calls this every 5 seconds to check progress
app.get('/transcribe/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress || null,
    transcript: job.status === 'done' ? job.transcript : null,
    error: job.status === 'error' ? job.error : null
  });
});

// ── Background processing ──
async function processJob(jobId, filePath, originalName, openaiKey) {
  try {
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 'Splitting audio into chunks...';

    const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const LIMIT_MB = 24;
    let fullTranscript = '';

    if (fileSizeMB <= LIMIT_MB) {
      jobs[jobId].progress = 'Transcribing audio...';
      fullTranscript = await transcribeFile(filePath, originalName, openaiKey);
    } else {
      const chunkPaths = splitFileIntoChunks(filePath, LIMIT_MB);
      const total = chunkPaths.length;
      console.log(`Job ${jobId}: split into ${total} chunks`);

      for (let i = 0; i < chunkPaths.length; i++) {
        jobs[jobId].progress = `Transcribing chunk ${i + 1} of ${total}...`;
        console.log(`Job ${jobId}: transcribing chunk ${i + 1}/${total}`);
        const t = await transcribeFile(chunkPaths[i], `chunk_${i}.mp3`, openaiKey);
        fullTranscript += (i > 0 ? ' ' : '') + t;
        try { fs.unlinkSync(chunkPaths[i]); } catch(e) {}
      }
    }

    try { fs.unlinkSync(filePath); } catch(e) {}

    console.log(`Job ${jobId}: done. Transcript length: ${fullTranscript.length} chars`);
    jobs[jobId].status = 'done';
    jobs[jobId].transcript = fullTranscript;
    jobs[jobId].progress = 'Complete';

  } catch (err) {
    try { fs.unlinkSync(filePath); } catch(e) {}
    console.error(`Job ${jobId} error:`, err.message);
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
  }
}

// ── Send a file to OpenAI Whisper ──
async function transcribeFile(filePath, filename, openaiKey) {
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
    throw new Error(`Whisper error (${response.status}): ${errData.error?.message || 'Check your OpenAI API key and billing.'}`);
  }

  const data = await response.json();
  return data.text || '';
}

// ── Split file into byte chunks ──
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

app.listen(PORT, () => console.log(`Mentored backend v3 running on port ${PORT}`));
