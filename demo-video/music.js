// Composes an original background track for the ad, timed to its sections, and writes it as a WAV file.
// Everything is synthesized here (no samples or third-party music), so there are no licensing concerns.
//
// Moods by section id (see ad-narration.js):
//   prompt   -> moody pad, with an impact when the CRITICAL stamp lands
//   premise* -> gentle groove (kick, hats, bass, chords)
//   problem  -> tension: darker chords, faster hats, driving bass, a riser into the next section
//   better   -> drop: deep impact, then a calm hopeful swell
//   brand    -> uplifting finish: bright chords, full beat, plucked arpeggios
const fs = require('fs');

const SR = 44100;
const BPM = 104;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

const midiHz = n => 440 * Math.pow(2, (n - 69) / 12);

// Chords as MIDI notes (pad voicing) with a bass root.
const CHORDS = {
  Am: { notes: [57, 60, 64], bass: 45 },
  F: { notes: [53, 57, 60], bass: 41 },
  C: { notes: [55, 60, 64], bass: 48 },
  G: { notes: [55, 59, 62], bass: 43 },
  Adim: { notes: [57, 60, 63], bass: 45 },
  Bb: { notes: [53, 58, 62], bass: 46 }
};

const PROGRESSIONS = {
  calm: ['Am', 'F', 'C', 'G'],
  tense: ['Adim', 'F', 'Adim', 'Bb'],
  bright: ['C', 'G', 'Am', 'F']
};

// Deterministic noise so every render sounds the same.
let seed = 12345;
const noise = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
};

function createTrack(seconds) {
  const length = Math.ceil(seconds * SR);
  return { left: new Float32Array(length), right: new Float32Array(length), length };
}

function mix(track, startSec, samples, gain = 1, pan = 0) {
  const start = Math.round(startSec * SR);
  const l = gain * (pan <= 0 ? 1 : 1 - pan);
  const r = gain * (pan >= 0 ? 1 : 1 + pan);
  for (let i = 0; i < samples.length; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= track.length) continue;
    track.left[idx] += samples[i] * l;
    track.right[idx] += samples[i] * r;
  }
}

// ---------- Instruments ----------

// Soft saw-like pad note: a few harmonics, slow attack and release.
function padNote(midi, seconds, detune = 0) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const f = midiHz(midi) * (1 + detune);
  const attack = Math.min(0.35, seconds / 3);
  const release = Math.min(0.45, seconds / 3);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * 1.4);
    const env = Math.min(1, t / attack) * Math.min(1, (seconds - t) / release);
    out[i] = v * env;
  }
  return out;
}

function bassNote(midi, seconds) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const f = midiHz(midi);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 3.5);
    out[i] = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * env;
  }
  return out;
}

function kick() {
  const n = Math.round(0.35 * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += (2 * Math.PI * (45 + 80 * Math.exp(-t * 32))) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * 9);
  }
  return out;
}

function hat(open = false) {
  const n = Math.round((open ? 0.18 : 0.05) * SR);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = noise();
    out[i] = (x - prev) * Math.exp(-(i / SR) * (open ? 18 : 75)); // crude high-pass
    prev = x;
  }
  return out;
}

function pluck(midi) {
  const n = Math.round(0.45 * SR);
  const out = new Float32Array(n);
  const f = midiHz(midi);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t * 7);
    out[i] = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t)) * env;
  }
  return out;
}

// Deep hit: falling sine plus a short noise burst.
function impact(seconds = 1.6) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += (2 * Math.PI * (32 + 40 * Math.exp(-t * 5))) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * 2.6) + noise() * 0.35 * Math.exp(-t * 18);
  }
  return out;
}

// Rising noise "whoosh" plus an upward sine sweep, getting louder towards the end.
function riser(seconds) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let lp = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const alpha = 0.02 + 0.5 * p * p; // filter opens up over time
    lp += alpha * (noise() - lp);
    phase += (2 * Math.PI * (180 + 700 * p * p)) / SR;
    const env = Math.pow(p, 1.8) * Math.min(1, (n - i) / (0.03 * SR));
    out[i] = (lp * 0.8 + Math.sin(phase) * 0.2) * env;
  }
  return out;
}

// ---------- Arrangement ----------

// Chords every bar, aligned to the global bar grid so the tempo never jumps between sections.
function layChords(track, from, to, progression, { pad = 0.05, bass = 0, bassEvery = BEAT } = {}) {
  const firstBar = Math.floor(from / BAR);
  for (let bar = firstBar; bar * BAR < to; bar++) {
    const start = Math.max(from, bar * BAR);
    const end = Math.min(to, (bar + 1) * BAR);
    if (end - start < 0.05) continue;
    const chord = CHORDS[progression[bar % progression.length]];
    if (pad) {
      chord.notes.forEach((note, i) => {
        mix(track, start, padNote(note, end - start, -0.0015), pad, -0.35 + i * 0.05);
        mix(track, start, padNote(note, end - start, 0.0015), pad, 0.35 - i * 0.05);
      });
    }
    if (bass) {
      for (let t = Math.ceil(start / bassEvery) * bassEvery; t < end - 0.02; t += bassEvery) {
        mix(track, t, bassNote(chord.bass, Math.min(bassEvery * 0.95, end - t)), bass);
      }
    }
  }
}

function layDrums(track, from, to, { kickEvery = BEAT, hatEvery = BEAT / 2, kickGain = 0.5, hatGain = 0.07 } = {}) {
  const k = kick();
  for (let t = Math.ceil(from / kickEvery) * kickEvery; t < to - 0.05; t += kickEvery) mix(track, t, k, kickGain);
  if (hatEvery) {
    for (let t = Math.ceil(from / hatEvery) * hatEvery; t < to - 0.02; t += hatEvery) {
      const offBeat = Math.abs((t / BEAT) % 1 - 0.5) < 0.01;
      mix(track, t, hat(offBeat && hatEvery >= BEAT / 2), hatGain, offBeat ? 0.25 : -0.2);
    }
  }
}

function layArpeggio(track, from, to, progression, gain = 0.06) {
  const step = BEAT / 4;
  for (let t = Math.ceil(from / step) * step, i = 0; t < to - 0.1; t += step, i++) {
    const chord = CHORDS[progression[Math.floor(t / BAR) % progression.length]];
    const notes = [...chord.notes.map(n => n + 12), chord.notes[0] + 24];
    mix(track, t, pluck(notes[i % notes.length]), gain, i % 2 ? 0.4 : -0.4);
  }
}

/**
 * Build the ad's music.
 * @param {{id: string, start: number, end: number}[]} sections  seconds from the start of the video
 * @param {number} totalSeconds  full video length
 * @param {string} outFile  .wav path
 */
function composeAdMusic(sections, totalSeconds, outFile) {
  const track = createTrack(totalSeconds);

  for (const { id, start, end } of sections) {
    if (id === 'prompt') {
      layChords(track, start, end, ['Am'], { pad: 0.045 });
      mix(track, start + 1.1, impact(1.4), 0.55); // CRITICAL stamp lands ~1.1 s into the section
    } else if (id.startsWith('premise')) {
      layChords(track, start, end, PROGRESSIONS.calm, { pad: 0.04, bass: 0.18, bassEvery: BEAT * 2 });
      layDrums(track, start, end, { kickEvery: BEAT * 2, hatEvery: BEAT / 2, kickGain: 0.4, hatGain: 0.05 });
    } else if (id === 'problem') {
      layChords(track, start, end, PROGRESSIONS.tense, { pad: 0.045, bass: 0.2, bassEvery: BEAT / 2 });
      layDrums(track, start, end, { kickEvery: BEAT, hatEvery: BEAT / 4, kickGain: 0.5, hatGain: 0.06 });
      mix(track, start, riser(end - start), 0.28);
    } else if (id === 'better') {
      mix(track, start, impact(2.2), 0.8);
      layChords(track, start + 0.4, end, ['C'], { pad: 0.035 });
    } else {
      // brand (and anything else): the uplifting finish
      layChords(track, start, end, PROGRESSIONS.bright, { pad: 0.045, bass: 0.2, bassEvery: BEAT });
      layDrums(track, start, end, { kickEvery: BEAT, hatEvery: BEAT / 2, kickGain: 0.5, hatGain: 0.06 });
      layArpeggio(track, start, end, PROGRESSIONS.bright, 0.055);
    }
  }

  // Fade in/out and normalize.
  const fadeIn = 0.4 * SR;
  const fadeOut = Math.min(2, totalSeconds / 4) * SR;
  let peak = 0;
  for (let i = 0; i < track.length; i++) {
    const g = Math.min(1, i / fadeIn) * Math.min(1, (track.length - i) / fadeOut);
    track.left[i] *= g;
    track.right[i] *= g;
    peak = Math.max(peak, Math.abs(track.left[i]), Math.abs(track.right[i]));
  }
  writeWav(outFile, track, peak > 0 ? 0.9 / peak : 1);
}

function writeWav(file, track, gain) {
  const dataBytes = track.length * 4; // 2 channels x 16-bit
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  const clamp = v => Math.max(-1, Math.min(1, v * gain));
  for (let i = 0; i < track.length; i++) {
    buf.writeInt16LE(Math.round(clamp(track.left[i]) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(clamp(track.right[i]) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

module.exports = { composeAdMusic };
