/** Web Audio buzzer emulator for the virtual RAKSHAK-KAPHA patch. */
let ctx: AudioContext | null = null;
let redTimer: ReturnType<typeof setInterval> | null = null;

function ac(): AudioContext {
  if (!ctx) {
    const C =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new C();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function chirp(freq: number, dur: number, gain = 0.06, type: OscillatorType = "square") {
  const a = ac();
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, a.currentTime);
  g.gain.setValueAtTime(0, a.currentTime);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0005, a.currentTime + dur);
  osc.connect(g).connect(a.destination);
  osc.start();
  osc.stop(a.currentTime + dur + 0.02);
}

export function yellowChirp() {
  chirp(1180, 0.09);
}

export function sweepAlarm() {
  const a = ac();
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(700, a.currentTime);
  osc.frequency.linearRampToValueAtTime(1900, a.currentTime + 0.18);
  osc.frequency.linearRampToValueAtTime(700, a.currentTime + 0.36);
  g.gain.setValueAtTime(0.001, a.currentTime);
  g.gain.linearRampToValueAtTime(0.075, a.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0005, a.currentTime + 0.38);
  osc.connect(g).connect(a.destination);
  osc.start();
  osc.stop(a.currentTime + 0.4);
}

export function startRedAlarm() {
  if (redTimer) return;
  sweepAlarm();
  redTimer = setInterval(sweepAlarm, 800);
}

export function stopRedAlarm() {
  if (redTimer) clearInterval(redTimer);
  redTimer = null;
}

export function confirmBeep() {
  chirp(880, 0.07, 0.05, "triangle");
  setTimeout(() => chirp(1320, 0.09, 0.05, "triangle"), 90);
}
