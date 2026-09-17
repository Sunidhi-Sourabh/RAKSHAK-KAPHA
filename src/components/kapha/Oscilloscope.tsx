import { useEffect, useRef } from "react";

interface Props {
  label: string;
  sublabel: string;
  color: string;
  /** returns sample in -1..1 for a given absolute time in seconds */
  sample: (t: number) => number;
  running: boolean;
  height?: number;
}

const WINDOW_S = 60;
const RATE = 50; // samples/s

export function Oscilloscope({ label, sublabel, color, sample, running, height = 150 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufRef = useRef<number[]>([]);
  const sampleRef = useRef(sample);
  sampleRef.current = sample;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const cap = WINDOW_S * RATE;

    const draw = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;

      if (running) {
        acc += dt;
        const step = 1 / RATE;
        let guard = 0;
        while (acc >= step && guard++ < 200) {
          acc -= step;
          bufRef.current.push(sampleRef.current(now / 1000));
          if (bufRef.current.length > cap) bufRef.current.shift();
        }
      }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // grid
      ctx.strokeStyle = "oklch(0.32 0.02 250 / 0.55)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 12; i++) {
        const x = (w / 12) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let i = 1; i < 4; i++) {
        const y = (h / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const buf = bufRef.current;
      if (buf.length > 1) {
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        for (let i = 0; i < buf.length; i++) {
          const x = (i / (cap - 1)) * w;
          const y = h / 2 - (buf[i] ?? 0) * (h / 2 - 8);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // leading dot
        const lx = ((buf.length - 1) / (cap - 1)) * w;
        const ly = h / 2 - (buf[buf.length - 1] ?? 0) * (h / 2 - 8);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [color, running]);

  return (
    <div className="panel-frame relative overflow-hidden p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="label-micro" style={{ color }}>
          {label}
        </span>
        <span className="label-micro">{sublabel}</span>
      </div>
      <canvas ref={canvasRef} style={{ width: "100%", height }} />
      <div className="mt-1 flex justify-between">
        <span className="label-micro">-60 s</span>
        <span className="label-micro">-30 s</span>
        <span className="label-micro">now</span>
      </div>
    </div>
  );
}
