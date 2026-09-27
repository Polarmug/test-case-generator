// Joins the animated intro and the app demo into one video: output/ad.mp4 + output/demo.mp4 -> output/final.mp4.
// If a music file is present (music.mp3 in this folder, or MUSIC=path), it is added under the demo part:
// looped to the video's length, faded in and out, and automatically turned down whenever the voice speaks.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OUT } = require('./lib');

const MUSIC = process.env.MUSIC || path.join(__dirname, 'music.mp3');
const MUSIC_VOLUME = Number(process.env.MUSIC_VOLUME || 0.25); // 0-1, before ducking under the voice

const parts = [path.join(OUT, 'ad.mp4'), path.join(OUT, 'demo.mp4')];
for (const file of parts) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.basename(file)}. Run "npm run ad" and "npm run record" first.`);
    process.exit(1);
  }
}

const seconds = file =>
  parseFloat(String(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])));

const outFile = path.join(OUT, 'final.mp4');
const hasMusic = fs.existsSync(MUSIC);

// Normalize both parts (size, frame rate, audio rate) so they join cleanly.
const filters = [
  '[0:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[v0]',
  '[1:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[v1]',
  '[0:a]aresample=48000[a0]'
];

const inputs = ['-i', parts[0], '-i', parts[1]];

// The ad already has its own composed music, so music.mp3 only plays under the app demo part.
if (hasMusic) {
  const demoLength = seconds(parts[1]);
  const fadeOut = Math.min(3, demoLength / 4);
  console.log(`Music under the demo: ${MUSIC} (volume ${MUSIC_VOLUME}, ducked under the voice)`);
  inputs.push('-stream_loop', '-1', '-i', MUSIC); // loop the track in case it's shorter than the demo
  filters.push(
    `[2:a]aresample=48000,atrim=0:${demoLength.toFixed(2)},volume=${MUSIC_VOLUME},` +
      `afade=t=in:d=1.5,afade=t=out:st=${(demoLength - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}[music]`,
    '[1:a]aresample=48000,asplit=2[demoVoice][demoKey]',
    // Duck: the music drops while the voice is speaking and comes back up in the gaps.
    '[music][demoKey]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450[ducked]',
    '[demoVoice][ducked]amix=inputs=2:normalize=0:duration=first[a1]'
  );
} else {
  console.log('No music.mp3 found, so the demo part has voice only (the ad keeps its own music).');
  filters.push('[1:a]aresample=48000[a1]');
}

filters.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');

execFileSync('ffmpeg', [
  '-y', ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart',
  outFile
], { stdio: 'inherit' });

console.log(`\nDone: ${outFile}`);
