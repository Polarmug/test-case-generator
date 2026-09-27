# Demo video recorder

Records a narrated demo of the live app: Puppeteer drives the site (with a visible cursor and highlights) while the screen is recorded, an AI voice reads `narration.js`, and ffmpeg combines them into `output/demo.mp4`.

Each run makes **one real generation on the live site**, so it uses a small amount of bobcoins. If a backup AI answers instead of Bob, the script stops rather than record narration that says "IBM Bob" over another AI's answer.

## Requirements

- Google Chrome
- `ffmpeg` and `ffprobe` on PATH
- Optional, for a natural neural voice: `pip install edge-tts` (otherwise the Windows built-in voice is used)

## Run

```
cd demo-video
npm install
npm run ad        # animated intro       -> output/ad.mp4   (fast, no Bob needed)
npm run record    # live app demo        -> output/demo.mp4 (one real Bob generation)
npm run combine   # intro + demo joined  -> output/final.mp4
```

The intro and the demo are separate so you can re-render the intro quickly while tweaking it.

| Part | Animation / actions | Voice-over |
|---|---|---|
| Intro | `ad/ad.html` (typed headlines, dot grid, messy "problem" words and test cases, brand card) | `ad-narration.js` |
| Demo | `record.js` (drives the live app) | `narration.js` |

Shared voice and video helpers live in `lib.js`.

## Options (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `APP_URL` | the Render URL | Site to record, e.g. `http://localhost:3001` |
| `TTS` | `auto` | `edge`, `windows`, or `auto` (edge-tts if installed) |
| `VOICE` | `en-US-AriaNeural` | edge-tts voice (`edge-tts --list-voices`), e.g. `en-US-GuyNeural` |
| `VOICE_RATE` | `+5%` | edge-tts speaking speed |
| `WINDOWS_VOICE` | system default | e.g. `Microsoft Zira Desktop` |
| `HEADFUL` | off | `1` to watch the browser while it records |
| `AUDIO_OFFSET_MS` | `0` | Shift all narration later (positive) or earlier (negative) if it drifts |
| `CHROME_PATH` | standard install path | Path to chrome.exe |
| `KEEP_FRAMES` | off | `1` to keep the raw screenshot frames in `output/frames` |

The screen is captured as timestamped frames, each held until the next one arrives, so the video's length matches real time and the narration stays in sync even during quiet moments like waiting for Bob.

In Windows cmd, set a variable before running, e.g. `set VOICE=en-US-GuyNeural` then `npm run record`.

Edit `narration.js` to change what is said; each scene lasts at least as long as its line.
