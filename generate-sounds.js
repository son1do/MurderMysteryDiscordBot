const fs = require('fs');
const path = require('path');

function createWavBuffer(sampleRate, samples) {
  const byteRate = sampleRate * 2; // 16bit mono
  const blockAlign = 2;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(1, 22);  // NumChannels (1 = mono)
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM data (16-bit signed)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buffer.writeInt16LE(Math.floor(val), 44 + i * 2);
  }

  return buffer;
}

const SAMPLE_RATE = 44100;
const soundsDir = path.join(__dirname, 'sounds');
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
}

// 1. notice.wav: 明るくはっきり聞こえる「ピン・ポーン」（C5 -> G4）
const noticeSamples = [];
const note1Duration = 0.5; // 秒
const note2Duration = 1.0; // 秒
const freq1 = 587.33; // D5 (少し高めにして通りを良く)
const freq2 = 440.00; // A4

// Note 1 (ピン)
const note1Len = Math.floor(SAMPLE_RATE * note1Duration);
for (let i = 0; i < note1Len; i++) {
  const t = i / SAMPLE_RATE;
  // 基音 + 倍音でリッチで通りやすい音に
  const base = Math.sin(2 * Math.PI * freq1 * t);
  const harmonic = Math.sin(2 * Math.PI * freq1 * 2 * t) * 0.25;
  const envelope = Math.exp(-3.5 * t);
  noticeSamples.push((base + harmonic) * envelope * 0.9);
}

// Note 2 (ポーン)
const note2Len = Math.floor(SAMPLE_RATE * note2Duration);
for (let i = 0; i < note2Len; i++) {
  const t = i / SAMPLE_RATE;
  const base = Math.sin(2 * Math.PI * freq2 * t);
  const harmonic = Math.sin(2 * Math.PI * freq2 * 2 * t) * 0.25;
  const envelope = Math.exp(-2.5 * t);
  noticeSamples.push((base + harmonic) * envelope * 0.9);
}

fs.writeFileSync(path.join(soundsDir, 'notice.wav'), createWavBuffer(SAMPLE_RATE, noticeSamples));
console.log('Created: sounds/notice.wav (high volume, harmonic rich)');

// 2. finish.wav: 終了アラーム（ピピピッ × 3回、はっきりしたビープ音）
const finishSamples = [];
const beepFreq = 1174.66; // D6
const beepDuration = 0.1;
const silenceShort = 0.06;
const silenceLong = 0.25;

function addBeep(samples) {
  const len = Math.floor(SAMPLE_RATE * beepDuration);
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.sin((Math.PI * i) / len);
    const base = Math.sin(2 * Math.PI * beepFreq * t);
    const harmonic = Math.sin(2 * Math.PI * beepFreq * 2 * t) * 0.2;
    samples.push((base + harmonic) * env * 0.95);
  }
}

function addSilence(samples, duration) {
  const len = Math.floor(SAMPLE_RATE * duration);
  for (let i = 0; i < len; i++) {
    samples.push(0);
  }
}

for (let r = 0; r < 3; r++) {
  for (let b = 0; b < 3; b++) {
    addBeep(finishSamples);
    if (b < 2) addSilence(finishSamples, silenceShort);
  }
  if (r < 2) addSilence(finishSamples, silenceLong);
}

fs.writeFileSync(path.join(soundsDir, 'finish.wav'), createWavBuffer(SAMPLE_RATE, finishSamples));
console.log('Created: sounds/finish.wav (high volume, clear alert)');
