// Shared by record.js (app demo) and ad.js (animated intro): settings, AI voice, screen capture and ffmpeg steps.
const { execFile, execFileSync, spawnSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TTS = process.env.TTS || 'auto'; // 'edge' (neural voice, needs `pip install edge-tts`), 'windows', or 'auto'
const EDGE_VOICE = process.env.VOICE || 'en-US-AriaNeural';
const EDGE_RATE = process.env.VOICE_RATE || '+5%';
const WINDOWS_VOICE = process.env.WINDOWS_VOICE || ''; // e.g. "Microsoft Zira Desktop"; empty = system default
const HEADFUL = process.env.HEADFUL === '1'; // set to 1 to watch the browser while it records
const AUDIO_OFFSET_MS = Number(process.env.AUDIO_OFFSET_MS || 0); // nudge voice timing if it drifts

const OUT = path.join(__dirname, 'output');
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1.5 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- AI voice ----------

function commandWorks(command, args) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

async function speakEdge(text, file) {
  const textFile = file.replace(/\.\w+$/, '.txt');
  fs.writeFileSync(textFile, text, 'utf8');
  await execFileAsync('edge-tts', ['--voice', EDGE_VOICE, `--rate=${EDGE_RATE}`, '--file', textFile, '--write-media', file]);
}

async function speakWindows(text, file) {
  const textFile = file.replace(/\.\w+$/, '.txt');
  fs.writeFileSync(textFile, text, 'utf8');
  // Paths and voice go in through environment variables so nothing needs quoting.
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'if ($env:TTS_VOICE) { $s.SelectVoice($env:TTS_VOICE) }',
    '$s.Rate = 1',
    '$s.SetOutputToWaveFile($env:TTS_OUT)',
    '$s.Speak([IO.File]::ReadAllText($env:TTS_IN))',
    '$s.Dispose()'
  ].join('; ');
  await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, TTS_IN: textFile, TTS_OUT: file, TTS_VOICE: WINDOWS_VOICE }
  });
}

function audioSeconds(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(String(out));
}

const ttsEngine = () => (TTS === 'auto' ? (commandWorks('edge-tts', ['--help']) ? 'edge' : 'windows') : TTS);

const describeEngine = engine => (engine === 'edge' ? `edge-tts (${EDGE_VOICE})` : 'Windows built-in');

// Generate one scene's voice clip and measure its length.
async function makeVoice(engine, id, text) {
  const file = path.join(OUT, `voice-${id}.${engine === 'edge' ? 'mp3' : 'wav'}`);
  if (engine === 'edge') await speakEdge(text, file);
  else await speakWindows(text, file);
  const seconds = audioSeconds(file);
  console.log(`  voice ${id}: ${seconds.toFixed(1)} s`);
  return { file, seconds };
}

// ---------- Video ----------

// Chrome only sends a screencast frame when the screen changes, so recorders that assume a steady
// frame rate drop the quiet moments and the video runs shorter than real time, pushing the narration
// later and later. Instead, keep every frame with the time it arrived and hold it on screen until the
// next one, so the video's timeline matches the clock the scenes are timed with.
async function startRecording(page, framesDir) {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const cdp = await page.createCDPSession();
  const frames = [];
  let writes = Promise.resolve();

  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const file = path.join(framesDir, `frame-${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, atMs: Date.now() });
    writes = writes.then(() => fs.promises.writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080 });

  return {
    frames,
    // Returns the moment recording stopped. Take it before waiting for pending frame writes: those can
    // lag seconds behind during busy animations, which would otherwise hold the last frame on screen.
    async stop() {
      const endMs = Date.now();
      await cdp.send('Page.stopScreencast').catch(() => {});
      await writes;
      return endMs;
    }
  };
}

// Turn the timestamped frames into a constant-frame-rate video with the exact real-time length.
function framesToVideo(frames, endMs, outFile) {
  if (frames.length === 0) throw new Error('No frames were recorded.');
  const toPath = file => `file '${file.replace(/\\/g, '/')}'`;
  const lines = [];
  frames.forEach((frame, i) => {
    const nextMs = i + 1 < frames.length ? frames[i + 1].atMs : endMs;
    lines.push(toPath(frame.file), `duration ${Math.max(0.001, (nextMs - frame.atMs) / 1000).toFixed(3)}`);
  });
  lines.push(toPath(frames[frames.length - 1].file)); // the concat format ignores the last duration otherwise
  const listFile = `${outFile}.frames.txt`;
  fs.writeFileSync(listFile, lines.join('\n'));

  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    outFile
  ], { stdio: 'inherit' });
}

// Place each narration clip at its scene's start (relative to the first video frame) and add it to the video.
// Optional background music (same length as the video) is mixed underneath and ducked while the voice speaks.
function mux(videoFile, videoStartMs, timeline, outFile, { music, musicVolume = 0.3 } = {}) {
  const args = ['-y', '-i', videoFile];
  timeline.forEach(entry => args.push('-i', entry.file));
  const delayed = timeline.map((entry, i) => {
    const ms = Math.max(0, Math.round(entry.atMs - videoStartMs + AUDIO_OFFSET_MS));
    return `[${i + 1}:a]adelay=delays=${ms}:all=1[a${i}]`;
  });
  const voiceLabel = music ? 'voice' : 'aout';
  const mixed = `${timeline.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timeline.length}:normalize=0:duration=longest[${voiceLabel}]`;
  const filters = [...delayed, mixed];
  if (music) {
    const musicInput = timeline.length + 1;
    args.push('-i', music);
    filters.push(
      `[${musicInput}:a]aresample=48000,volume=${musicVolume}[music]`,
      '[voice]aresample=48000,asplit=2[voiceOut][voiceKey]',
      '[music][voiceKey]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450[ducked]',
      '[voiceOut][ducked]amix=inputs=2:normalize=0:duration=longest[aout]'
    );
  }
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    outFile
  );
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

module.exports = {
  CHROME_PATH, HEADFUL, OUT, VIEWPORT,
  sleep, ttsEngine, describeEngine, makeVoice,
  startRecording, framesToVideo, mux
};
