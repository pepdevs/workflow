// Text formatting shared by the commands.


export const usd = (n: number | null) =>
  n === null ? "-" : n > 0 && n < 0.05 ? "<$0.1" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;

export const eur = (n: number | null) =>
  n === null ? "-" : `€${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

// Counts from 1,000 up in thousands with one decimal and separators, so repository sizes read alike in every command.
export const thousands = (n: number) =>
  n < 1e3 ? String(n) : `${(n / 1e3).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`;

export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-");

// Hours, minutes and seconds as H:MM:SS, so right-aligned columns line up.
export function dur(ms: number | null): string {
  if (ms === null || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const times = (n: number | null) => (n === null || !Number.isFinite(n) ? "-" : `${n.toFixed(1)}x`);

export const oneLine = (text: string | null, width: number) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > width ? `${t.slice(0, width - 1)}…` : t;
};

// Last folder of a working directory, from a POSIX or a Windows path.
export const folderName = (cwd: string | null) => (cwd ?? "-").split(/[\\/]/).filter(Boolean).at(-1) ?? "/";

export function table(headers: string[], rows: string[][], rightAlign: number[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (rightAlign.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
