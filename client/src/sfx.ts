// Synthesized sound effects — no audio files, all generated with WebAudio so it
// ships in-bundle and works offline. ~5 short sounds keyed to sim events, plus
// a countdown blip. Silent until the first user gesture (autoplay policy) and
// respects the Sound setting.

import { settings } from './settings';

let ctx: AudioContext | null = null;

// Must be called from a user gesture (a tap/click) to unlock audio on iOS.
export function unlockAudio(): void {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  } catch {
    ctx = null;
  }
}

function on(): AudioContext | null {
  if (!settings.sound || !ctx) return null;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// A single enveloped oscillator.
function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain = 0.2,
  sweepTo?: number,
  delay = 0,
): void {
  const ac = on();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// A short filtered noise burst (for thuds / whooshes).
function noise(dur: number, gain: number, cutoff: number, sweepTo?: number): void {
  const ac = on();
  if (!ac) return;
  const t0 = ac.currentTime;
  const frames = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buf.getChannelData(0);
  // deterministic-enough pseudo-noise (avoids Math.random dependency concerns)
  let s = 0.1234;
  for (let i = 0; i < frames; i++) {
    s = (s * 16807) % 2147483647;
    data[i] = ((s / 2147483647) * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filt = ac.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(cutoff, t0);
  if (sweepTo) filt.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(ac.destination);
  src.start(t0);
}

// A dry whoosh when you throw a push.
export function sfxPush(): void {
  noise(0.14, 0.18, 1600, 500);
}
// The money sound: a bright metallic "ting" when a parry lands.
export function sfxClash(): void {
  tone(1320, 0.16, 'triangle', 0.22);
  tone(1980, 0.22, 'sine', 0.14, 2600);
}
// A soft body thud on hard contact.
export function sfxThud(): void {
  tone(120, 0.12, 'sine', 0.24, 60);
  noise(0.08, 0.12, 500);
}
// A descending thump when someone is knocked out.
export function sfxEliminated(): void {
  tone(300, 0.35, 'sawtooth', 0.22, 70);
  noise(0.25, 0.14, 900, 120);
}
// Countdown blips (higher pitch on "go").
export function sfxCountdown(go = false): void {
  tone(go ? 880 : 520, go ? 0.22 : 0.1, 'square', 0.16);
}
// A rising chime when the Núcleo is claimed.
export function sfxCore(): void {
  tone(660, 0.1, 'triangle', 0.18);
  tone(990, 0.14, 'triangle', 0.18, undefined, 0.06);
  tone(1320, 0.2, 'sine', 0.16, undefined, 0.12);
}
