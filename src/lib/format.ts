/** Amounts are in wei: 18 decimals (Mainsail is an EVM chain). */
export const DECIMALS = 18;
export const ARKTOSHI = 10n ** BigInt(DECIMALS);

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format a wei amount as a decimal TARK string (at most `maxDecimals` decimals, cut, not rounded). */
export function formatArk(value: string | bigint | null | undefined, maxDecimals = 8, minDecimals = 2): string {
  if (value === null || value === undefined || value === "") return "0";
  let v = typeof value === "bigint" ? value : BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const int = v / ARKTOSHI;
  let frac = (v % ARKTOSHI).toString().padStart(DECIMALS, "0").slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "");
  while (frac.length < Math.min(minDecimals, maxDecimals)) frac += "0";
  return (neg ? "-" : "") + group(int.toString()) + (frac ? "." + frac : "");
}

/** Parse a user-entered amount into wei. Returns null if invalid. */
export function parseArk(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d{0,18})?$/.test(s) || s === "" || s === ".") return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * ARKTOSHI + BigInt((f + "0".repeat(DECIMALS)).slice(0, DECIMALS));
}

export function arkToNumber(v: string | bigint | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const b = typeof v === "bigint" ? v : BigInt(v);
  // split first: wei amounts are past Number's exact range
  return Number(b / ARKTOSHI) + Number(b % ARKTOSHI) / 1e18;
}

export function formatFiat(n: number, currency: string): string {
  const cur = currency.toUpperCase();
  try {
    if (cur === "BTC" || cur === "ETH") {
      return `${n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 8 : 4 })} ${cur}`;
    }
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur,
      maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`;
  }
}

export function shortAddress(a: string | null | undefined, n = 6): string {
  if (!a) return "";
  return a.length > n * 2 + 3 ? `${a.slice(0, n)}…${a.slice(-n)}` : a;
}

export function timeAgo(unixSeconds: number): string {
  const d = Date.now() / 1000 - unixSeconds;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Milliseconds -> "12s" / "3m 05s". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "12 s ago" style for recent events, falling back to timeAgo. */
export function ago(unixSeconds: number, nowMs = Date.now()): string {
  const d = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (d < 60) return `${d} s ago`;
  return timeAgo(unixSeconds);
}

export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : n.toLocaleString("en-US");
}

/** Compact amount for tables: 1,234,567 / 12.34 / 0.0012 */
export function arkCompact(value: string | bigint | null | undefined): string {
  const n = arkToNumber(value);
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  // dust below 8 decimals (wei amounts) shows in full rather than as "0"
  const short = formatArk(value, 8, 0);
  return short === "0" || short === "-0" ? formatArk(value, 18, 0) : short;
}

/** Shortest age: "45s", "8m", "3h", "2d". */
export function agoShort(unixSeconds: number, nowMs = Date.now()): string {
  const d = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}
