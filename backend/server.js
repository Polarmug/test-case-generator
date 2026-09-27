require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { generateTestCases, configuredProviders, parseGenerateRequest } = require('./llm');
const fallback = require('./fallback.json');

const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

// Every AI run costs bobcoins / watsonx credits, so cap requests per visitor and parallel Bob runs.
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CONCURRENT_BOB_RUNS = Number(process.env.MAX_CONCURRENT_BOB_RUNS) || 2;

const requestLog = new Map(); // ip -> timestamps of recent requests
let activeBobRuns = 0;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    requestLog.set(ip, recent);
    return true;
  }
  recent.push(now);
  requestLog.set(ip, recent);
  return false;
}

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for the real client IP
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, providers: configuredProviders().map(p => p.name) });
});

app.post('/api/generate', async (req, res) => {
  let input;
  try {
    input = parseGenerateRequest(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  }
  if (activeBobRuns >= MAX_CONCURRENT_BOB_RUNS) {
    return res.status(429).json({ error: 'Bob is busy with other requests. Please try again in a moment.' });
  }

  activeBobRuns++;
  try {
    const result = await generateTestCases(input);
    res.json({ ...result, storyId: input.storyId, story: input.story, fallback: false });
  } catch (err) {
    // Keep the demo alive: serve a saved example instead of an error.
    console.error('Generation failed, serving fallback:', err.message);
    res.json({
      ...fallback,
      provider: 'fallback',
      model: '',
      fallback: true,
      notice: 'Live AI is unavailable right now, so this is a saved example result.'
    });
  } finally {
    activeBobRuns--;
  }
});

// In production the backend also serves the built frontend, so the app is one URL.
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  const providers = configuredProviders().map(p => p.name);
  console.log(`AI providers: ${providers.length ? providers.join(' -> ') : 'none'} -> saved example`);
});
