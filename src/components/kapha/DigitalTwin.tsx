import { useEffect, useState } from "react";
import type { TriageClass } from "@/lib/triage-model";

interface Props {
  triage: TriageClass;
  hr: number;
  audioOn: boolean;
  onToggleAudio: () => void;
  ashaActive: boolean;
  ashaRemaining: number;
  onAsha: () => void;
  linked: boolean;
}

const RING_COLOR: Record<TriageClass, string> = {
  0: "var(--vital-green)",
  1: "var(--vital-amber)",
  2: "var(--vital-red)",
};

const PIXELS = 12;

export function DigitalTwin({
  triage,
  hr,
  audioOn,
  onToggleAudio,
  ashaActive,
  ashaRemaining,
  onAsha,
  linked,
}: Props) {
  const [tick, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), triage === 2 ? 220 : 90);
    return () => clearInterval(id);
  }, [triage]);

  const color = RING_COLOR[triage];
  const flashOff = triage === 2 && tick % 2 === 0;

  const pixelOpacity = (i: number) => {
    if (!mounted) return 0.7;
    if (triage === 2) return flashOff ? 0.08 : 1;
    if (triage === 1) return 0.9;
    const wave = (Math.sin(tick / 6 - i / 1.7) + 1) / 2;
    return 0.2 + wave * 0.8;
  };

  return (
    <div className="panel-frame p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-widest">HARDWARE DIGITAL TWIN</h3>
          <p className="label-micro mt-1">ESP32-S3 CHEST PATCH · NODE KP-01</p>
        </div>
        <span
          className="label-micro rounded-sm border px-2 py-1"
          style={{ color: linked ? "var(--vital-green)" : "var(--muted-foreground)" }}
        >
          {linked ? "LINK ACTIVE" : "STANDBY"}
        </span>
      </div>

      {/* Patch body */}
      <div className="relative mx-auto flex aspect-square w-full max-w-[290px] items-center justify-center rounded-[36%] border border-border bg-panel-raised">
        <div className="absolute inset-3 rounded-[34%] border border-border/70" />

        {/* NeoPixel ring */}
        <div className="relative h-[76%] w-[76%]">
          {Array.from({ length: PIXELS }).map((_, i) => {
            const angle = (i / PIXELS) * Math.PI * 2 - Math.PI / 2;
            const r = 46;
            const x = 50 + Math.cos(angle) * r;
            const y = 50 + Math.sin(angle) * r;
            const op = pixelOpacity(i);
            return (
              <span
                key={i}
                className="absolute h-3 w-3 rounded-full"
                style={{
                  left: `${x.toFixed(3)}%`,
                  top: `${y.toFixed(3)}%`,
                  transform: "translate(-50%, -50%)",
                  backgroundColor: color,
                  opacity: +op.toFixed(3),
                  boxShadow: `0 0 ${(10 + op * 16).toFixed(2)}px ${color}`,
                }}
              />
            );
          })}

          {/* MCU core */}
          <div className="absolute inset-[22%] flex flex-col items-center justify-center rounded-md border border-border bg-background">
            <span className="label-micro">WS2812B · GPIO18</span>
            <span
              className="readout mt-1 text-3xl"
              style={{ color, textShadow: `0 0 22px ${color}88` }}
            >
              {Math.round(hr)}
            </span>
            <span className="label-micro">BPM</span>
          </div>
        </div>

        {/* Buzzer */}
        <div className="absolute bottom-4 flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${audioOn && triage > 0 ? "flash-alarm" : ""}`}
            style={{
              backgroundColor: audioOn && triage > 0 ? color : "var(--muted-foreground)",
            }}
          />
          <span className="label-micro">BUZZER GPIO19</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          onClick={onToggleAudio}
          className="rounded-sm border border-border bg-panel-raised px-3 py-2 text-[0.65rem] tracking-[0.18em] uppercase transition-colors hover:bg-secondary"
          style={{ color: audioOn ? "var(--vital-green)" : "var(--muted-foreground)" }}
        >
          {audioOn ? "Buzzer armed" : "Buzzer muted"}
        </button>
        <button
          onClick={onAsha}
          className="rounded-sm border px-3 py-2 text-[0.65rem] tracking-[0.18em] uppercase transition-colors"
          style={{
            borderColor: ashaActive ? "var(--vital-cyan)" : "var(--border)",
            color: ashaActive ? "var(--vital-cyan)" : "var(--foreground)",
            backgroundColor: ashaActive ? "oklch(0.83 0.13 205 / 0.12)" : "var(--panel-raised)",
          }}
        >
          {ashaActive ? `ASHA mode ${ashaRemaining}s` : "ASHA triage mode"}
        </button>
      </div>
    </div>
  );
}
