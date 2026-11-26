// 音效(WebAudio 合成,不需要音檔)。設定可以關。
let ctx = null;
let enabled = true;
export function setSound(on) { enabled = !!on; }

function tone(freq, dur = 0.08, type = 'sine', gain = 0.06, delay = 0) {
  if (!enabled) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (e) { /* 沒有音效裝置就算了 */ }
}

export const sfx = {
  buy: () => tone(880, 0.09, 'triangle'),
  sell: () => tone(523, 0.09, 'triangle'),
  stop: () => { tone(330, 0.12, 'square', 0.04); tone(247, 0.16, 'square', 0.04, 0.12); },
  target: () => { tone(784, 0.08, 'triangle'); tone(1047, 0.12, 'triangle', 0.06, 0.08); },
  error: () => tone(160, 0.18, 'sawtooth', 0.04),
  start: () => { tone(523, 0.08); tone(659, 0.08, 'sine', 0.06, 0.08); tone(784, 0.12, 'sine', 0.06, 0.16); },
  end: () => { tone(784, 0.1); tone(659, 0.1, 'sine', 0.06, 0.1); tone(523, 0.2, 'sine', 0.06, 0.2); },
  achieve: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'triangle', 0.06, i * 0.09)),
  tick: () => tone(1200, 0.03, 'sine', 0.02),
};
