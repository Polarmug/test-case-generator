// Records a narrated demo video of the live app.
// 1. Generates an AI voice clip per scene (edge-tts neural voice, or Windows' built-in voice).
// 2. Puppeteer drives the site with a visible cursor while the screen is recorded.
//    Each scene lasts at least as long as its narration, so voice and screen stay in sync.
// 3. ffmpeg places each clip at its scene's start time and muxes everything into output/demo.mp4.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const narration = require('./narration');
const {
  CHROME_PATH, HEADFUL, OUT, VIEWPORT,
  sleep, ttsEngine, describeEngine, makeVoice,
  startRecording, framesToVideo, mux
} = require('./lib');

const APP_URL = process.env.APP_URL || 'https://test-case-generator-w0q6.onrender.com';
const SCENE_PAUSE_MS = 600; // breathing room after each narration line
const BOB_TIMEOUT_MS = 180_000;

// Voice clips for every scene with fixed text; dynamic scenes are voiced during recording.
async function makeVoices(engine) {
  console.log(`Voice: ${describeEngine(engine)}`);
  const voices = {};
  for (const { id, text, dynamic } of narration) {
    if (!dynamic) voices[id] = await makeVoice(engine, id, text);
  }
  return voices;
}

// First test case on screen (rows are sorted High priority first), for the "results" narration.
async function readFirstTestCase(page) {
  return page.$eval('tbody tr:first-child', row => {
    const reasonLine = [...row.querySelectorAll('.sub')].find(el => /^Why /.test(el.textContent));
    return {
      scenario: row.querySelector('.scenario')?.textContent.trim() ?? '',
      priority: row.querySelector('.priority')?.textContent.trim() ?? '',
      reason: reasonLine ? reasonLine.textContent.replace(/^Why \w+:\s*/, '').trim() : ''
    };
  });
}

// ---------- Page helpers: visible cursor and highlights ----------

// Headless recordings have no mouse pointer, so draw one that glides to each target.
async function installOverlay(page) {
  await page.addStyleTag({
    content: `
      #demo-cursor {
        position: fixed; z-index: 99999; left: 50%; top: 40%;
        width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
        background: rgba(255, 255, 255, 0.35); border: 2px solid rgba(69, 137, 255, 0.8);
        box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3); pointer-events: none; opacity: 0.75;
        transition: left 0.6s ease, top 0.6s ease, transform 0.15s ease, opacity 0.15s ease;
      }
      /* Semi-transparent so it never hides text; solid only for the moment of a click. */
      #demo-cursor.pressed { transform: scale(0.65); opacity: 1; }
      .demo-highlight {
        outline: 3px solid #f1c21b !important; outline-offset: 4px; border-radius: 6px;
      }
      #demo-downloads {
        position: fixed; z-index: 99998; right: 20px; bottom: 20px; width: 460px; max-height: 80vh; overflow: hidden;
        padding: 12px 14px; border-radius: 10px; background: #202124; color: #e8eaed;
        border: 1px solid #3c4043; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
        font: 13px/1.45 'Segoe UI', system-ui, sans-serif; animation: demo-dl-in 0.3s ease-out;
      }
      @keyframes demo-dl-in { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
      #demo-downloads .demo-dl-title { font-weight: 600; margin: 4px 0 8px; color: #bdc1c6; }
      #demo-downloads .demo-dl-item { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid #3c4043; }
      #demo-downloads .demo-dl-check {
        display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
        background: #1e8e3e; color: #fff; font-weight: 700; flex-shrink: 0;
      }
      #demo-downloads .demo-dl-name { font-weight: 600; }
      #demo-downloads .demo-dl-meta { margin-left: auto; color: #9aa0a6; white-space: nowrap; }
      #demo-downloads pre {
        margin: 0; padding: 10px; max-height: 260px; overflow: hidden; border-radius: 6px;
        background: #171717; color: #c8e1ff; font: 11.5px/1.45 Consolas, ui-monospace, monospace; white-space: pre;
      }
    `
  });
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    document.body.appendChild(cursor);
  });
}

// Scroll an element into view and glide the cursor onto it. Accepts a selector or an element handle.
async function pointAt(page, target) {
  const el = typeof target === 'string' ? await page.waitForSelector(target, { visible: true, timeout: 15_000 }) : target;
  await el.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await sleep(700);
  const box = await el.boundingBox();
  if (box) {
    await page.evaluate(
      (x, y) => {
        const cursor = document.getElementById('demo-cursor');
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
      },
      box.x + box.width / 2,
      box.y + box.height / 2
    );
    await sleep(700);
  }
  return el;
}

async function click(page, target) {
  const el = await pointAt(page, target);
  await page.evaluate(() => document.getElementById('demo-cursor').classList.add('pressed'));
  await el.click();
  await sleep(180);
  await page.evaluate(() => document.getElementById('demo-cursor').classList.remove('pressed'));
  await sleep(400);
}

async function highlight(page, target, ms = 2500) {
  const el = await pointAt(page, target);
  await el.evaluate(e => e.classList.add('demo-highlight'));
  await sleep(ms);
  await el.evaluate(e => e.classList.remove('demo-highlight')).catch(() => {}); // element may have re-rendered
}

// ---------- Downloads ----------

const DOWNLOAD_NAME = /^test-cases-.*\.(csv|feature)$/;

function clearDownloads() {
  for (const name of fs.readdirSync(OUT)) {
    if (DOWNLOAD_NAME.test(name)) fs.rmSync(path.join(OUT, name), { force: true });
  }
}

// Wait until Chrome has finished saving a file with the given extension into the output folder.
async function waitForDownload(extension, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const name = fs.readdirSync(OUT).find(n => DOWNLOAD_NAME.test(n) && n.endsWith(`.${extension}`));
    if (name) {
      const file = path.join(OUT, name);
      await sleep(300); // let the write finish
      const size = fs.statSync(file).size;
      if (size > 0) return { name, file, size };
    }
    await sleep(200);
  }
  throw new Error(`The ${extension} export did not download within ${timeoutMs / 1000} s.`);
}

// Chrome's own download bubble is browser UI, not part of the page, so it never shows in a page
// recording. This panel stands in for it, and is only shown for files confirmed on disk above.
async function showDownloads(page, files, preview) {
  const rows = files.map(f => ({
    name: f.name,
    size: f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`
  }));
  await page.evaluate(
    (rows, preview) => {
      document.getElementById('demo-downloads')?.remove();
      const panel = document.createElement('div');
      panel.id = 'demo-downloads';
      const title = document.createElement('div');
      title.className = 'demo-dl-title';
      title.textContent = 'Downloads';
      panel.appendChild(title);
      for (const row of rows) {
        const item = document.createElement('div');
        item.className = 'demo-dl-item';
        item.innerHTML = '<span class="demo-dl-check">✓</span><span class="demo-dl-name"></span><span class="demo-dl-meta"></span>';
        item.querySelector('.demo-dl-name').textContent = row.name;
        item.querySelector('.demo-dl-meta').textContent = `${row.size} · Download complete`;
        panel.appendChild(item);
      }
      if (preview) {
        const head = document.createElement('div');
        head.className = 'demo-dl-title';
        head.textContent = `${preview.name} (preview)`;
        const pre = document.createElement('pre');
        pre.textContent = preview.text;
        panel.append(head, pre);
      }
      document.body.appendChild(panel);
    },
    rows,
    preview
  );
}

async function hideDownloads(page) {
  await page.evaluate(() => document.getElementById('demo-downloads')?.remove());
}

// ---------- Main ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const engine = ttsEngine();
  const voices = await makeVoices(engine);

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: !HEADFUL, defaultViewport: VIEWPORT });
  let recorder;
  try {
    const page = await browser.newPage();
    // Record in dark mode.
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('theme', 'dark');
      } catch {
        // ignore
      }
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });

    console.log(`Opening ${APP_URL} (a sleeping Render app can take about a minute to wake up)...`);
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 120_000 });
    await installOverlay(page);

    const framesDir = path.join(OUT, 'frames');
    recorder = await startRecording(page, framesDir);
    await sleep(500); // let the first frame arrive before the first scene starts
    const timeline = [];

    // Run a scene's actions while its narration plays; the scene ends when both are done.
    // Scene start times use the same clock as the frame timestamps.
    const scene = async (id, action) => {
      console.log(`Scene: ${id}`);
      timeline.push({ id, atMs: Date.now(), file: voices[id].file });
      await Promise.all([action(), sleep(voices[id].seconds * 1000)]);
      await sleep(SCENE_PAUSE_MS);
    };

    await scene('intro', async () => {
      await sleep(1500);
      await pointAt(page, 'select.example-select');
      await page.select('select.example-select', 'Bank transfer');
      await sleep(800);
      await highlight(page, '#criteria', 3000);
    });

    await scene('problem', async () => {
      await click(page, '.actions button.primary');
      // Bring the "IBM Bob is working on your story" card fully into view so its steps show while Bob works.
      const progress = await page.waitForSelector('.progress-card', { visible: true, timeout: 10_000 }).catch(() => null);
      if (progress) {
        await progress.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await sleep(800);
        const box = await progress.boundingBox();
        if (box) {
          // Park the cursor just right of the card title, out of the way of the steps.
          await page.evaluate(
            (x, y) => {
              const cursor = document.getElementById('demo-cursor');
              cursor.style.left = `${x}px`;
              cursor.style.top = `${y}px`;
            },
            Math.min(box.x + box.width - 90, box.x + 420),
            box.y + 26
          );
        }
      }
      await page.waitForSelector('tbody tr', { timeout: BOB_TIMEOUT_MS });
    });

    // The narration is about Bob, so don't make a video of a backup AI's answer.
    const provider = (await page.$eval('.provider', e => e.textContent).catch(() => '')).trim();
    if (!provider.includes('IBM Bob')) {
      throw new Error(`Bob didn't answer this run (${provider || 'no provider shown'}). Try again when Bob is available.`);
    }

    // Voice the "results" line from Bob's real first test case while the badge scene plays.
    const firstTestCase = await readFirstTestCase(page);
    console.log(`First test case: ${firstTestCase.priority} | ${firstTestCase.scenario}`);
    // Catch here so a failure can't become an unhandled rejection while the badge scene runs.
    const resultsVoice = makeVoice(engine, 'results', narration.resultsText(firstTestCase)).catch(err => err);

    await scene('bob', () => highlight(page, '.provider', 4500));

    const voiced = await resultsVoice;
    if (voiced instanceof Error) throw new Error(`Could not create the results narration: ${voiced.message}`);
    voices.results = voiced;
    await scene('results', async () => {
      // Linger on the first test case, then scroll slowly through the rest of the table.
      await highlight(page, 'tbody tr:first-child', 4000);
      const rows = await page.$$('tbody tr');
      for (const row of rows.slice(1, 6)) {
        await row.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await sleep(1300);
      }
    });

    await scene('priority', async () => {
      await highlight(page, 'tbody tr:first-child .priority', 2500);
      await click(page, 'button.stat-priority-high');
      // Scroll down so the filtered list (High priority rows only) is on screen.
      await sleep(600);
      await page.$eval('.table-card', e => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      await sleep(900);
      await highlight(page, '.table-card', 3500);
      await click(page, '.summary button.stat'); // "total" chip: show everything again
      await sleep(800);
    });

    await scene('coverage', async () => {
      await highlight(page, 'ul.coverage', 3000);
      await click(page, 'ul.coverage .chip');
    });

    if (await page.$('.gaps-card')) {
      await scene('gaps', async () => {
        await highlight(page, '.gaps-card .gap', 3500);
        const addButtons = (await page.$$('.gap-suggestion button')).slice(0, 2);
        for (const button of addButtons) await click(page, button);
        await highlight(page, '#criteria', 3000);
      });
    } else {
      console.log('Scene: gaps (skipped: Bob found no gaps this run)');
    }

    await scene('edit', async () => {
      // Edit the last test case: add a note to its scenario and save. It keeps its place in the list
      // because its priority doesn't change.
      await click(page, 'tbody tr:last-child .row-actions button');
      const scenarioInput = await pointAt(page, '#edit-scenario');
      await scenarioInput.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' (reviewed by QA)', { delay: 60 });
      await sleep(600);
      await click(page, 'tr.editing .row-actions button.primary'); // Save
      await highlight(page, 'tbody tr:has(.edited-tag)', 2500);

      // Delete a different test case, show the Undo bar, then undo it.
      await click(page, 'tbody tr:nth-last-child(2) .row-actions button.danger');
      await highlight(page, '.banner-info', 2500);
      await click(page, '.banner-info .link-btn'); // Undo
      await sleep(800);
    });

    // Export both formats, confirm each file actually landed on disk, then show them (the narration
    // says both downloaded successfully, so any failure stops the recording instead).
    clearDownloads();
    await scene('export', async () => {
      await click(page, 'button::-p-text(Export CSV)');
      const csv = await waitForDownload('csv');
      await showDownloads(page, [csv]);
      await sleep(2000);

      await click(page, 'button::-p-text(Export Gherkin)');
      const feature = await waitForDownload('feature');
      const previewText = fs.readFileSync(feature.file, 'utf8').split(/\r?\n/).slice(0, 16).join('\n');
      await showDownloads(page, [csv, feature], { name: feature.name, text: previewText });
      console.log(`Downloaded: ${csv.name} (${csv.size} B), ${feature.name} (${feature.size} B)`);
      await sleep(5000);
      await hideDownloads(page);
    });

    await scene('close', async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(900);
      await highlight(page, '.provider', 3500);
    });

    await sleep(1000);
    const endMs = await recorder.stop();
    const { frames } = recorder;
    recorder = null;
    await browser.close();

    console.log(`Building video from ${frames.length} frames...`);
    const screenFile = path.join(OUT, 'screen.mp4');
    framesToVideo(frames, endMs, screenFile);

    console.log('Adding the narration...');
    const outFile = path.join(OUT, 'demo.mp4');
    mux(screenFile, frames[0].atMs, timeline, outFile);
    if (process.env.KEEP_FRAMES !== '1') fs.rmSync(framesDir, { recursive: true, force: true });
    console.log(`\nDone: ${outFile}`);
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
    await browser.close().catch(() => {}); // already closed on success
  }
}

main().catch(err => {
  console.error(`\nRecording failed: ${err.message}`);
  process.exit(1);
});
