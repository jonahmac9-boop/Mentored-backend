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

// ── Job storage directory — persists across health check restarts ──
const JOBS_DIR = path.join(os.tmpdir(), 'mentored_jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// ── Clean up job files older than 30 minutes — runs every 10 minutes ──
function cleanOldJobs() {
  try {
    const files = fs.readdirSync(JOBS_DIR);
    const cutoff = Date.now() - 30 * 60 * 1000;
    let cleaned = 0;
    for (const file of files) {
      const filePath = path.join(JOBS_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`Cleaned up ${cleaned} old job files`);
  } catch(e) {
    console.error('Cleanup error:', e.message);
  }
}
setInterval(cleanOldJobs, 10 * 60 * 1000);

// ── Read job from disk ──
function readJob(jobId) {
  try {
    const filePath = path.join(JOBS_DIR, `${jobId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    return null;
  }
}

// ── Write job to disk ──
function writeJob(job) {
  try {
    const filePath = path.join(JOBS_DIR, `${job.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(job), 'utf8');
  } catch(e) {
    console.error('Failed to write job:', e.message);
  }
}

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 250 * 1024 * 1024 }
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'Mentored backend v4 running', version: '4.0.0' });
});

// ── Keepalive ping ──
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: Date.now() });
});

// ── SUBMIT job ──
app.post('/transcribe/submit', upload.single('audio'), (req, res) => {
  try {
    const openaiKey = req.body.openaiKey;
    if (!openaiKey) return res.status(400).json({ error: 'Missing OpenAI API key' });
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const jobId = uuidv4();
    const job = {
      id: jobId,
      status: 'queued',
      progress: 'Job received, starting...',
      transcript: null,
      error: null,
      createdAt: Date.now()
    };

    writeJob(job);

    const fileSizeMB = req.file.size / (1024 * 1024);
    console.log(`Job ${jobId} queued: ${req.file.originalname}, ${fileSizeMB.toFixed(1)}MB`);

    // Respond immediately
    res.json({ jobId });

    // Process in background
    processJob(jobId, req.file.path, req.file.originalname, openaiKey);

  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POLL job status ──
app.get('/transcribe/status/:jobId', (req, res) => {
  const job = readJob(req.params.jobId);
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
    let job = readJob(jobId);
    job.status = 'processing';
    job.progress = 'Splitting audio into chunks...';
    writeJob(job);

    const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const LIMIT_MB = 24;
    let fullTranscript = '';

    if (fileSizeMB <= LIMIT_MB) {
      job.progress = 'Transcribing audio...';
      writeJob(job);
      fullTranscript = await transcribeFile(filePath, originalName, openaiKey);
    } else {
      const chunkPaths = splitFileIntoChunks(filePath, LIMIT_MB);
      const total = chunkPaths.length;
      console.log(`Job ${jobId}: split into ${total} chunks`);

      for (let i = 0; i < chunkPaths.length; i++) {
        job = readJob(jobId); // Re-read from disk each time
        job.progress = `Transcribing chunk ${i + 1} of ${total}...`;
        writeJob(job);

        console.log(`Job ${jobId}: transcribing chunk ${i + 1}/${total}`);
        const t = await transcribeFile(chunkPaths[i], `chunk_${i}.mp3`, openaiKey);
        fullTranscript += (i > 0 ? ' ' : '') + t;
        try { fs.unlinkSync(chunkPaths[i]); } catch(e) {}
      }
    }

    try { fs.unlinkSync(filePath); } catch(e) {}

    // Write final result to disk
    job = readJob(jobId);
    job.status = 'done';
    job.progress = 'Complete';
    job.transcript = fullTranscript;
    writeJob(job);

    console.log(`Job ${jobId}: done. Transcript length: ${fullTranscript.length} chars`);

  } catch (err) {
    try { fs.unlinkSync(filePath); } catch(e) {}
    console.error(`Job ${jobId} error:`, err.message);
    const job = readJob(jobId) || { id: jobId };
    job.status = 'error';
    job.error = err.message;
    writeJob(job);
  }
}

// ── Transcribe a single file with OpenAI Whisper ──
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

app.listen(PORT, () => console.log(`Mentored backend v4 running on port ${PORT}`));
