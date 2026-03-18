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

// ── CLAUDE API PROXY ──
// Browser can't call Anthropic directly (CORS) — route through here
app.post('/claude', async (req, res) => {
  try {
    const { anthropicKey, prompt, transcript } = req.body;
    if (!anthropicKey) return res.status(400).json({ error: 'Missing Anthropic API key' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    if (!transcript) return res.status(400).json({ error: 'Missing transcript' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `${prompt}\n\n---TRANSCRIPT---\n${transcript}`
        }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Claude API error (${response.status}): ${errData.error?.message || 'Check your Anthropic API key.'}`);
    }

    const data = await response.json();
    res.json({ content: data.content[0].text });

  } catch (err) {
    console.error('Claude proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
      fullTranscript = await transcribeFile(filePath, originalName, openaiKey, 0);
    } else {
      const chunkPaths = splitFileIntoChunks(filePath, LIMIT_MB);
      const total = chunkPaths.length;
      console.log(`Job ${jobId}: split into ${total} chunks`);

      // Detect actual bitrate from file metadata for accurate time offsets
      const actualBitrateKbps = getMP3Bitrate(filePath);
      console.log(`Job ${jobId}: detected bitrate ${actualBitrateKbps}kbps`);
      const chunkSizeBytes = LIMIT_MB * 1024 * 1024;
      const actualChunkDuration = (chunkSizeBytes * 8) / (actualBitrateKbps * 1000);

      for (let i = 0; i < chunkPaths.length; i++) {
        job = readJob(jobId);
        job.progress = `Transcribing chunk ${i + 1} of ${total}...`;
        writeJob(job);

        console.log(`Job ${jobId}: transcribing chunk ${i + 1}/${total}, offset ${(i * actualChunkDuration).toFixed(1)}s`);
        const timeOffset = i * actualChunkDuration;
        const t = await transcribeFile(chunkPaths[i], `chunk_${i}.mp3`, openaiKey, timeOffset);
        fullTranscript += (i > 0 ? '\n' : '') + t;
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

// ── Transcribe a single file with OpenAI Whisper — returns timecoded transcript ──
async function transcribeFile(filePath, filename, openaiKey, timeOffsetSeconds) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

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

  // Stitch segments with offset-adjusted timestamps
  if (data.segments && data.segments.length > 0) {
    return data.segments.map(seg => {
      const rawSeconds = seg.start + timeOffsetSeconds;
      const hours = Math.floor(rawSeconds / 3600);
      const mins = Math.floor((rawSeconds % 3600) / 60);
      const secs = Math.floor(rawSeconds % 60);
      const timestamp = hours > 0
        ? `${hours}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`
        : `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
      return `[${timestamp}] ${seg.text.trim()}`;
    }).join('\n');
  }

  // Fallback to plain text if no segments
  return data.text || '';
}

// ── Read actual bitrate from MP3 header ──
// Reads the first valid MP3 frame header to get the real bitrate
// Falls back to 128kbps if it can't be determined
function getMP3Bitrate(filePath) {
  try {
    const buffer = Buffer.alloc(10240); // Read first 10KB
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 10240, 0);
    fs.closeSync(fd);

    // Bitrate table for MPEG1 Layer3 (standard MP3)
    const bitrateTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];

    // Scan for MP3 sync word (0xFF 0xE0 or higher)
    for (let i = 0; i < buffer.length - 4; i++) {
      if (buffer[i] === 0xFF && (buffer[i + 1] & 0xE0) === 0xE0) {
        const bitrateIndex = (buffer[i + 2] >> 4) & 0x0F;
        const bitrate = bitrateTable[bitrateIndex];
        if (bitrate > 0) {
          return bitrate;
        }
      }
    }
    console.log('Could not detect bitrate, defaulting to 192kbps');
    return 192;
  } catch (e) {
    console.log('Bitrate detection error, defaulting to 192kbps:', e.message);
    return 192;
  }
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
