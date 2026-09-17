import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MetricCard } from "@/components/kapha/MetricCard";
import { Oscilloscope } from "@/components/kapha/Oscilloscope";
import { DigitalTwin } from "@/components/kapha/DigitalTwin";
import { TriageBanner } from "@/components/kapha/TriageBanner";
import { kapha_triage_infer, TRIAGE_META, type InferenceResult } from "@/lib/triage-model";
import {
  benchmarkFrame,
  buildFhirBundle,
  parseTelemetryLine,
  type TelemetryFrame,
} from "@/lib/kapha-stream";
import {
  confirmBeep,
  startRedAlarm,
  stopRedAlarm,
  yellowChirp,
} from "@/lib/kapha-audio";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RAKSHAK-KAPHA · Field Triage Command Prototype" },
      {
        name: "description",
        content:
          "Interactive functional prototype of RAKSHAK-KAPHA: virtual ESP32 chest patch, live vitals oscilloscopes, on-device TinyML mSTaRT triage and one-click ABDM FHIR export.",
      },
      { property: "og:title", content: "RAKSHAK-KAPHA · Field Triage Command Prototype" },
      {
        property: "og:description",
        content:
          "Zero-install browser demo: hardware digital twin, 7-tree on-device triage inference, and ABDM FHIR casualty export.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CommandConsole,
});

type Source = "replay" | "serial" | "ble";

const SOURCES: { id: Source; name: string; detail: string }[] = [
  {
    id: "replay",
    name: "Dataset replay",
    detail: "kapha_benchmark_dataset.csv · 600 rows @1 Hz · no hardware",
  },
  { id: "serial", name: "Web Serial", detail: "Physical ESP32 node @ 115200 baud" },
  { id: "ble", name: "Web Bluetooth", detail: "Heart Rate GATT 0x180D / 0x2A37" },
];

function statusOf(kind: string, v: number): "ok" | "warn" | "crit" {
  switch (kind) {
    case "hr":
      return v > 130 ? "crit" : v > 110 ? "warn" : "ok";
    case "spo2":
      return v < 91 ? "crit" : v < 95 ? "warn" : "ok";
    case "rr":
      return v > 27 ? "crit" : v > 22 ? "warn" : "ok";
    case "hrv":
      return v < 13 ? "crit" : v < 22 ? "warn" : "ok";
    default:
      return v > 1900 ? "crit" : v > 1009 ? "warn" : "ok";
  }
}

function CommandConsole() {
  const [source, setSource] = useState<Source>("replay");
  const [running, setRunning] = useState(true);
  const [linked, setLinked] = useState(false);
  const [frame, setFrame] = useState<TelemetryFrame>(() => benchmarkFrame(0));
  const [result, setResult] = useState<InferenceResult>(() =>
    kapha_triage_infer(benchmarkFrame(0)),
  );
  const [audioOn, setAudioOn] = useState(false);
  const [asha, setAsha] = useState(0);
  const [log, setLog] = useState<string[]>(["SYS · console initialised · model kapha_forest_7"]);
  const [avgLatency, setAvgLatency] = useState(0);
  const [frameCount, setFrameCount] = useState(0);

  const historyRef = useRef<TelemetryFrame[]>([]);
  const clockRef = useRef(0);
  const latRef = useRef<number[]>([]);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const pushLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLog((l) => [`${stamp} · ${line}`, ...l].slice(0, 60));
  }, []);

  const ingest = useCallback((f: TelemetryFrame) => {
    const r = kapha_triage_infer(f);
    historyRef.current = [...historyRef.current, f].slice(-600);
    latRef.current = [...latRef.current, r.latencyMs].slice(-120);
    setAvgLatency(latRef.current.reduce((a, b) => a + b, 0) / latRef.current.length);
    setFrameCount((c) => c + 1);
    setFrame(f);
    setResult((prev) => {
      if (prev.label !== r.label) {
        pushLog(
          `TRIAGE · ${TRIAGE_META[prev.label].code} → ${TRIAGE_META[r.label].code} (votes ${r.votes.join("/")})`,
        );
      }
      return r;
    });
  }, [pushLog]);

  /* ---------------- replay engine (1 Hz) ---------------- */
  useEffect(() => {
    if (source !== "replay" || !running) return;
    const id = setInterval(() => {
      clockRef.current = (clockRef.current + 1) % 600;
      ingest(benchmarkFrame(clockRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, [source, running, ingest]);

  /* ---------------- buzzer emulation ---------------- */
  useEffect(() => {
    if (!audioOn) {
      stopRedAlarm();
      return;
    }
    if (result.label === 2) startRedAlarm();
    else stopRedAlarm();
    if (result.label === 1) yellowChirp();
  }, [audioOn, result.label]);

  useEffect(() => stopRedAlarm, []);

  /* ---------------- ASHA countdown ---------------- */
  useEffect(() => {
    if (asha <= 0) return;
    const id = setTimeout(() => setAsha((a) => a - 1), 1000);
    return () => clearTimeout(id);
  }, [asha]);

  /* ---------------- waveform generators ---------------- */
  const ppg = useCallback((t: number) => {
    const f = frameRef.current;
    const phase = (t * (f.hr / 60)) % 1;
    const systolic = Math.exp(-Math.pow((phase - 0.22) / 0.15, 2));
    const dicrotic = 0.34 * Math.exp(-Math.pow((phase - 0.52) / 0.11, 2));
    const perfusion = 0.55 + (f.spo2 - 86) / 40;
    return (systolic + dicrotic - 0.42) * 1.35 * Math.min(1.05, perfusion);
  }, []);

  const resp = useCallback((t: number) => {
    const f = frameRef.current;
    const phase = (t * (f.rr / 60)) % 1;
    const tidal = Math.sin(phase * Math.PI * 2) * (0.9 - (f.rr - 14) / 45);
    const crackle = Math.sin(t * 78) * 0.06 * (f.co2 > 1500 ? 2.4 : 1);
    return Math.max(-1, Math.min(1, tidal + crackle));
  }, []);

  /* ---------------- Web Serial ---------------- */
  const connectSerial = useCallback(async () => {
    const nav = navigator as Navigator & { serial?: { requestPort: () => Promise<unknown> } };
    if (!nav.serial) {
      pushLog("ERR · Web Serial unavailable — use Chrome/Edge desktop");
      return;
    }
    try {
      const port = (await nav.serial.requestPort()) as {
        open: (o: { baudRate: number }) => Promise<void>;
        readable: ReadableStream<Uint8Array>;
      };
      await port.open({ baudRate: 115200 });
      setSource("serial");
      setLinked(true);
      pushLog("SERIAL · port open @115200 · awaiting JSON telemetry");
      const reader = port.readable.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          clockRef.current += 1;
          const f = parseTelemetryLine(line.trim(), clockRef.current);
          if (f) ingest(f);
        }
      }
      setLinked(false);
      pushLog("SERIAL · stream closed");
    } catch (e) {
      pushLog(`ERR · serial ${(e as Error).message}`);
    }
  }, [ingest, pushLog]);

  /* ---------------- Web Bluetooth ---------------- */
  const connectBle = useCallback(async () => {
    const bt = (navigator as Navigator & { bluetooth?: unknown }).bluetooth as
      | {
          requestDevice: (o: unknown) => Promise<{
            gatt?: {
              connect: () => Promise<{
                getPrimaryService: (s: unknown) => Promise<{
                  getCharacteristic: (c: unknown) => Promise<{
                    startNotifications: () => Promise<void>;
                    addEventListener: (e: string, cb: (ev: Event) => void) => void;
                  }>;
                }>;
              }>;
            };
          }>;
        }
      | undefined;

    if (!bt) {
      pushLog("ERR · Web Bluetooth unavailable in this browser");
      return;
    }
    try {
      const device = await bt.requestDevice({ filters: [{ services: ["heart_rate"] }] });
      const server = await device.gatt!.connect();
      const svc = await server.getPrimaryService("heart_rate");
      const ch = await svc.getCharacteristic("heart_rate_measurement");
      await ch.startNotifications();
      setSource("ble");
      setLinked(true);
      pushLog("BLE · subscribed to 0x2A37 notifications");

      const rr: number[] = [];
      ch.addEventListener("characteristicvaluechanged", (ev: Event) => {
        const dv = (ev.target as unknown as { value: DataView }).value;
        const flags = dv.getUint8(0);
        let idx = 1;
        const hr = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
        idx += flags & 0x01 ? 2 : 1;
        if (flags & 0x08) idx += 2;
        if (flags & 0x10) {
          while (idx + 1 < dv.byteLength) {
            rr.push((dv.getUint16(idx, true) * 1000) / 1024);
            idx += 2;
          }
        }
        const tail = rr.slice(-30);
        let rmssd = 40;
        if (tail.length > 2) {
          let s = 0;
          for (let i = 1; i < tail.length; i++)
            s += Math.pow((tail[i] ?? 0) - (tail[i - 1] ?? 0), 2);
          rmssd = Math.sqrt(s / (tail.length - 1));
        }
        clockRef.current += 1;
        const est = frameRef.current;
        ingest({
          t: clockRef.current,
          phase: "BLE WEARABLE",
          hr,
          spo2: est.spo2,
          rr: est.rr,
          hrv: +rmssd.toFixed(1),
          co2: est.co2,
        });
      });
    } catch (e) {
      pushLog(`ERR · bluetooth ${(e as Error).message}`);
    }
  }, [ingest, pushLog]);

  const selectSource = (id: Source) => {
    if (id === "serial") return void connectSerial();
    if (id === "ble") return void connectBle();
    setSource("replay");
    setLinked(false);
    pushLog("REPLAY · kapha_benchmark_dataset.csv engaged (600 rows @1 Hz)");
  };

  const exportFhir = () => {
    const frames = historyRef.current.length ? historyRef.current : [frame];
    const bundle = buildFhirBundle(frames, TRIAGE_META[result.label].code);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `abdm-fhir-bundle-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    pushLog(`ABDM · FHIR transaction Bundle exported (${bundle.entry.length} resources)`);
  };

  const triggerAsha = () => {
    setAsha(10);
    if (audioOn) confirmBeep();
    pushLog("ASHA · 10-second field triage window opened on node KP-01");
  };

  const elapsed = useMemo(() => {
    const m = Math.floor(frame.t / 60);
    const s = Math.floor(frame.t % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [frame.t]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1500px] px-4 py-6 lg:px-8">
      {/* Header */}
      <header className="panel-frame mb-4 flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex items-center gap-4">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-sm border"
            style={{ borderColor: "var(--vital-green)", color: "var(--vital-green)" }}
          >
            <span className="readout text-lg">क</span>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-[0.16em] sm:text-xl">RAKSHAK-KAPHA</h1>
            <p className="label-micro mt-0.5">
              INCIDENT COMMANDER CONSOLE · SIH 2026 · FUNCTIONAL DIGITAL PROTOTYPE
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <Stat label="Stream" value={elapsed} />
          <Stat label="Frames" value={String(frameCount)} />
          <Stat
            label="Avg infer"
            value={`${(avgLatency * 1000).toFixed(1)} µs`}
            tone="var(--vital-green)"
          />
          <Stat label="Phase" value={frame.phase} tone="var(--vital-cyan)" />
          {frame.truth !== undefined && (
            <Stat
              label="vs ground truth"
              value={frame.truth === result.label ? "MATCH" : "DIVERGE"}
              tone={
                frame.truth === result.label ? "var(--vital-green)" : "var(--vital-amber)"
              }
            />
          )}
          <button
            onClick={exportFhir}
            className="rounded-sm border px-3 py-2 text-[0.65rem] tracking-[0.18em] uppercase transition-colors"
            style={{
              borderColor: "var(--vital-green)",
              color: "var(--vital-green)",
              backgroundColor: "oklch(0.82 0.19 152 / 0.1)",
            }}
          >
            Export ABDM FHIR
          </button>
        </div>
      </header>

      {/* Source switcher */}
      <section className="mb-4 grid gap-2 sm:grid-cols-3">
        {SOURCES.map((s) => {
          const active = source === s.id;
          return (
            <button
              key={s.id}
              onClick={() => selectSource(s.id)}
              className="panel-frame p-3 text-left transition-colors hover:bg-panel-raised"
              style={active ? { borderColor: "var(--vital-cyan)" } : undefined}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-xs font-semibold tracking-[0.14em] uppercase"
                  style={{ color: active ? "var(--vital-cyan)" : "var(--foreground)" }}
                >
                  {s.name}
                </span>
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: active ? "var(--vital-cyan)" : "var(--muted-foreground)",
                    boxShadow: active ? "0 0 12px var(--vital-cyan)" : "none",
                  }}
                />
              </div>
              <p className="label-micro mt-1.5">{s.detail}</p>
            </button>
          );
        })}
      </section>

      <div className="mb-4">
        <TriageBanner result={result} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_330px]">
        <div className="space-y-4">
          {/* Metrics */}
          <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <MetricCard
              label="Heart rate"
              unit="bpm"
              value={frame.hr}
              range="60–100"
              status={statusOf("hr", frame.hr)}
              fill={frame.hr / 180}
            />
            <MetricCard
              label="SpO₂"
              unit="%"
              value={frame.spo2}
              decimals={1}
              range="95–100"
              status={statusOf("spo2", frame.spo2)}
              fill={(frame.spo2 - 80) / 20}
            />
            <MetricCard
              label="Resp rate"
              unit="br/min"
              value={frame.rr}
              range="12–20"
              status={statusOf("rr", frame.rr)}
              fill={frame.rr / 40}
            />
            <MetricCard
              label="HRV RMSSD"
              unit="ms"
              value={frame.hrv}
              decimals={1}
              range="20–60"
              status={statusOf("hrv", frame.hrv)}
              fill={frame.hrv / 60}
            />
            <MetricCard
              label="Inhaled CO₂"
              unit="ppm"
              value={frame.co2}
              range="400–600"
              status={statusOf("co2", frame.co2)}
              fill={frame.co2 / 3200}
            />
          </section>

          {/* Oscilloscopes */}
          <section className="grid gap-3 xl:grid-cols-2">
            <Oscilloscope
              label="CH1 · ARTERIAL PPG"
              sublabel={`${Math.round(frame.hr)} BPM · DICROTIC NOTCH VISIBLE`}
              color="var(--vital-green)"
              sample={ppg}
              running={running}
            />
            <Oscilloscope
              label="CH2 · RESPIRATORY ACOUSTIC / TIDAL"
              sublabel={`${frame.rr.toFixed(1)} BR/MIN · CO₂ ${Math.round(frame.co2)} PPM`}
              color="var(--vital-cyan)"
              sample={resp}
              running={running}
            />
          </section>

          {/* Log */}
          <section className="panel-frame p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="label-micro">FIELD EVENT LOG</span>
              <div className="flex gap-1.5">
                {[
                  { l: "BASELINE", t: 0 },
                  { l: "ACUTE", t: 250 },
                  { l: "RECOVERY", t: 470 },
                ].map((j) => (
                  <button
                    key={j.l}
                    onClick={() => {
                      clockRef.current = j.t;
                      ingest(benchmarkFrame(j.t));
                      pushLog(`REPLAY · seek to ${j.l} phase (t=${j.t}s)`);
                    }}
                    className="label-micro rounded-sm border px-2 py-1 hover:bg-panel-raised"
                  >
                    {j.l}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setRunning((r) => !r)}
                className="label-micro rounded-sm border px-2 py-1 hover:bg-panel-raised"
              >
                {running ? "PAUSE STREAM" : "RESUME STREAM"}
              </button>
            </div>
            <div className="h-40 space-y-1 overflow-y-auto pr-1 text-[0.7rem] leading-relaxed">
              {log.map((l, i) => (
                <div
                  key={i}
                  className="text-muted-foreground"
                  style={i === 0 ? { color: "var(--vital-green)" } : undefined}
                >
                  {l}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <DigitalTwin
            triage={result.label}
            hr={frame.hr}
            audioOn={audioOn}
            onToggleAudio={() => {
              setAudioOn((a) => {
                const next = !a;
                if (next) confirmBeep();
                pushLog(`AUDIO · buzzer ${next ? "armed" : "muted"}`);
                return next;
              });
            }}
            ashaActive={asha > 0}
            ashaRemaining={asha}
            onAsha={triggerAsha}
            linked={source === "replay" ? running : linked}
          />

          <section className="panel-frame p-4">
            <h3 className="text-sm font-semibold tracking-widest">EDGE INFERENCE ENGINE</h3>
            <p className="label-micro mt-1">
              JS PORT OF triage_model.h · kapha_triage_infer()
            </p>
            <dl className="mt-3 space-y-2 text-xs">
              <Row k="Ensemble" v="7 × decision tree" />
              <Row k="Vote rule" v="majority (argmax)" />
              <Row k="Features" v="hr · spo2 · rr · hrv · co2" />
              <Row k="Last latency" v={`${(result.latencyMs * 1000).toFixed(1)} µs`} tone="var(--vital-green)" />
              <Row k="Test accuracy" v="1.0000 held-out" />
              <Row k="Footprint" v="0 heap · 0 malloc" />
              <Row k="Interop" v="HL7 FHIR R4 / ABDM" />
            </dl>
            <p className="mt-3 text-[0.68rem] leading-relaxed text-muted-foreground">
              Identical decision boundaries run on the ESP32 node — the browser executes the exact
              exported forest, so on-screen classification matches field hardware bit for bit.
            </p>
          </section>
        </div>
      </div>

      <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <span className="label-micro">
          RAKSHAK-KAPHA · SMART INDIA HACKATHON 2026 · MASS-CASUALTY TRIAGE WEARABLE
        </span>
        <span className="label-micro">
          FIRMWARE: firmware/rakshak_kapha.ino · MODEL: firmware/triage_model.h · PIPELINE: firmware/pipeline.py
        </span>
      </footer>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="label-micro">{label}</div>
      <div className="readout text-base" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-1.5">
      <dt className="label-micro">{k}</dt>
      <dd className="readout text-xs" style={tone ? { color: tone } : undefined}>
        {v}
      </dd>
    </div>
  );
}
