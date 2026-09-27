// Renders the animated intro (ad/ad.html) with its voice-over into output/ad.mp4.
// It doesn't touch the live app or Bob, so it's quick to re-run while tweaking the ad.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');
const adNarration = require('./ad-narration');
const { composeAdMusic } = require('./music');
const {
  CHROME_PATH, HEADFUL, OUT, VIEWPORT,
  sleep, ttsEngine, describeEngine, makeVoice,
  startRecording, framesToVideo, mux
} = require('./lib');

const SECTION_PAUSE_MS = 350; // small gap between lines

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const engine = ttsEngine();
  console.log(`Voice: ${describeEngine(engine)}`);
  const voices = {};
  for (const { id, text } of adNarration) voices[id] = await makeVoice(engine, `ad-${id}`, text);

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: !HEADFUL, defaultViewport: VIEWPORT });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(__dirname, 'ad', 'ad.html')).href, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.ad.ready);

    const framesDir = path.join(OUT, 'ad-frames');
    const recorder = await startRecording(page, framesDir);
    await sleep(500);
    const timeline = [];

    for (const { id } of adNarration) {
      console.log(`Section: ${id}`);
      const ms = Math.round(voices[id].seconds * 1000);
      timeline.push({ id, atMs: Date.now(), file: voices[id].file });
      // The page animates for the length of the line; also wait for the audio in case the page finishes early.
      await Promise.all([page.evaluate((name, duration) => window.ad.play(name, duration), id, ms), sleep(ms)]);
      await sleep(SECTION_PAUSE_MS);
    }
    await sleep(300); // short tail so the last word isn't cut off

    const endMs = await recorder.stop();
    const { frames } = recorder;
    await browser.close();

    console.log(`Building video from ${frames.length} frames...`);
    const screenFile = path.join(OUT, 'ad-screen.mp4');
    framesToVideo(frames, endMs, screenFile);

    // Compose music timed to the sections (seconds from the first frame), unless turned off with AD_MUSIC=0.
    let music;
    if (process.env.AD_MUSIC !== '0') {
      console.log('Composing the ad music...');
      const videoStart = frames[0].atMs;
      const totalSeconds = (endMs - videoStart) / 1000;
      const sections = timeline.map((entry, i) => ({
        id: entry.id,
        start: Math.max(0, (entry.atMs - videoStart) / 1000),
        end: i + 1 < timeline.length ? (timeline[i + 1].atMs - videoStart) / 1000 : totalSeconds
      }));
      music = path.join(OUT, 'ad-music.wav');
      composeAdMusic(sections, totalSeconds, music);
    }

    console.log('Adding the voice-over and music...');
    const outFile = path.join(OUT, 'ad.mp4');
    mux(screenFile, frames[0].atMs, timeline, outFile, {
      music,
      musicVolume: Number(process.env.AD_MUSIC_VOLUME || 0.35)
    });
    if (process.env.KEEP_FRAMES !== '1') fs.rmSync(framesDir, { recursive: true, force: true });
    console.log(`\nDone: ${outFile}`);
  } finally {
    await browser.close().catch(() => {}); // already closed on success
  }
}

main().catch(err => {
  console.error(`\nAd render failed: ${err.message}`);
  process.exit(1);
});
