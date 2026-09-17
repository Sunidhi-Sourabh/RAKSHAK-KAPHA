interface Props {
  label: string;
  unit: string;
  value: number;
  decimals?: number;
  range: string;
  status: "ok" | "warn" | "crit";
  fill: number; // 0..1
}

const TONE: Record<Props["status"], string> = {
  ok: "var(--vital-green)",
  warn: "var(--vital-amber)",
  crit: "var(--vital-red)",
};

export function MetricCard({ label, unit, value, decimals = 0, range, status, fill }: Props) {
  const tone = TONE[status];
  return (
    <div className="panel-frame relative overflow-hidden p-3">
      <div
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: tone, boxShadow: `0 0 14px ${tone}` }}
      />
      <div className="flex items-start justify-between">
        <span className="label-micro">{label}</span>
        <span className="label-micro" style={{ color: tone }}>
          {status === "ok" ? "NOM" : status === "warn" ? "WATCH" : "CRIT"}
        </span>
      </div>
      <div className="mt-2 flex items-end gap-1.5">
        <span className="readout text-4xl" style={{ color: tone, textShadow: `0 0 20px ${tone}55` }}>
          {value.toFixed(decimals)}
        </span>
        <span className="label-micro pb-1">{unit}</span>
      </div>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(2, fill * 100))}%`, backgroundColor: tone }}
        />
      </div>
      <div className="mt-1.5 label-micro">REF {range}</div>
    </div>
  );
}
