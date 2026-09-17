import csvRaw from "@/data/kapha_benchmark_dataset.csv?raw";
import type { Vitals } from "./triage-model";

export interface TelemetryFrame extends Vitals {
  t: number; // seconds since stream start
  phase: string;
  /** ground-truth label from the benchmark dataset, when available */
  truth?: number;
}

const PHASE_NAMES = ["BASELINE", "ACUTE INGRESS", "PARTIAL RECOVERY"];

/**
 * The real 600-row / 10-minute benchmark dataset produced by pipeline.py
 * (kapha_benchmark_dataset.csv), parsed once at module load.
 * Columns: t_s,hr,spo2,rr,hrv,co2,phase,triage
 */
export const BENCHMARK: TelemetryFrame[] = csvRaw
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [t, hr, spo2, rr, hrv, co2, phase, triage] = line.split(",");
    return {
      t: Number(t),
      hr: Number(hr),
      spo2: Number(spo2),
      rr: Number(rr),
      hrv: Number(hrv),
      co2: Number(co2),
      phase: PHASE_NAMES[Number(phase)] ?? `PHASE ${phase}`,
      truth: Number(triage),
    };
  })
  .filter((f) => Number.isFinite(f.hr));

const FALLBACK: TelemetryFrame = {
  t: 0,
  hr: 72,
  spo2: 98,
  rr: 15,
  hrv: 50,
  co2: 500,
  phase: "BASELINE",
  truth: 0,
};

export function benchmarkFrame(index: number): TelemetryFrame {
  if (BENCHMARK.length === 0) return FALLBACK;
  const i = ((index % BENCHMARK.length) + BENCHMARK.length) % BENCHMARK.length;
  return BENCHMARK[i] ?? FALLBACK;
}

/** Parses one line of ESP32 JSON telemetry into a frame. */
export function parseTelemetryLine(line: string, t: number): TelemetryFrame | null {
  try {
    const o = JSON.parse(line);
    if (typeof o.hr !== "number") return null;
    return {
      t,
      phase: typeof o.phase === "string" ? o.phase : "LIVE NODE",
      hr: o.hr,
      spo2: o.spo2 ?? 97,
      rr: o.rr ?? 16,
      hrv: o.hrv ?? o.rmssd ?? 40,
      co2: o.co2 ?? 500,
    };
  } catch {
    return null;
  }
}

/** HL7 FHIR R4 transaction Bundle formatted for ABDM ingestion. */
export function buildFhirBundle(frames: TelemetryFrame[], triage: string) {
  const now = new Date().toISOString();
  const patientId = "urn:uuid:kapha-patient-0001";
  const latest = frames[frames.length - 1] ?? FALLBACK;

  const obs = (code: string, display: string, value: number, unit: string) => ({
    fullUrl: `urn:uuid:obs-${code.toLowerCase()}-${Date.now()}-${Math.round(Math.random() * 1e5)}`,
    resource: {
      resourceType: "Observation",
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs",
            },
          ],
        },
      ],
      code: { coding: [{ system: "http://loinc.org", code, display }] },
      subject: { reference: patientId },
      effectiveDateTime: now,
      valueQuantity: { value, unit, system: "http://unitsofmeasure.org", code: unit },
    },
    request: { method: "POST", url: "Observation" },
  });

  return {
    resourceType: "Bundle",
    id: `rakshak-kapha-${Date.now()}`,
    meta: {
      lastUpdated: now,
      profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Bundle"],
    },
    type: "transaction",
    timestamp: now,
    entry: [
      {
        fullUrl: patientId,
        resource: {
          resourceType: "Patient",
          identifier: [{ system: "https://healthid.abdm.gov.in", value: "XX-XXXX-XXXX-1234" }],
          name: [{ text: "FIELD CASUALTY 0001" }],
        },
        request: { method: "POST", url: "Patient" },
      },
      obs("8867-4", "Heart rate", latest.hr, "/min"),
      obs("59408-5", "Oxygen saturation", latest.spo2, "%"),
      obs("9279-1", "Respiratory rate", latest.rr, "/min"),
      obs("80404-7", "R-R interval SD (RMSSD)", latest.hrv, "ms"),
      obs("19889-5", "Inhaled CO2", latest.co2, "[ppm]"),
      {
        fullUrl: `urn:uuid:triage-${Date.now()}`,
        resource: {
          resourceType: "ClinicalImpression",
          status: "completed",
          subject: { reference: patientId },
          date: now,
          summary: `mSTaRT on-device TinyML triage classification: ${triage}`,
          description: `Derived by kapha_triage_infer 7-tree ensemble over ${frames.length} telemetry frames.`,
        },
        request: { method: "POST", url: "ClinicalImpression" },
      },
    ],
  };
}
