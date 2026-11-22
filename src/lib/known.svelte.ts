/**
 * Named wallets that are not validators (exchanges, ARK team wallets), the same list ArkScan uses:
 * ArkEcosystem/common mainnet/known-wallets-extended.json. A copy ships with the site so names
 * show even when GitHub is unreachable; the live file is fetched at most once a day (GitHub serves
 * it with CORS open) and cached, so new entries appear without a rebuild.
 */
import bundled from "./known-wallets.json";
import { STORE } from "./site";
import { load, save } from "./storage";

export type KnownType = "exchange" | "team";
export interface KnownWallet {
  address: string;
  name: string;
  type: KnownType;
}

const SOURCE = "https://raw.githubusercontent.com/ArkEcosystem/common/master/mainnet/known-wallets-extended.json";
const TTL = 24 * 60 * 60_000;
const cacheKey = () => `${STORE}:known`;

/** Keep only well-formed entries: the file is third-party data shown on the page. */
function clean(raw: unknown): KnownWallet[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownWallet[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const { address, name, type } = x as Record<string, unknown>;
    if (typeof address !== "string" || !/^[A-Za-z0-9]{34}$/.test(address)) continue;
    if (typeof name !== "string" || !name.trim()) continue;
    out.push({ address, name: name.trim().slice(0, 40), type: type === "team" ? "team" : "exchange" });
  }
  return out;
}

export const known = $state({ list: clean(bundled) });
let byAddress = new Map(known.list.map((k) => [k.address, k]));

function use(list: KnownWallet[]) {
  if (!list.length) return;
  known.list = list;
  byAddress = new Map(list.map((k) => [k.address, k]));
}

/** The known wallet at `address`, if any. Reads `known.list` so templates re-render. */
export function knownWallet(address: string | undefined | null): KnownWallet | undefined {
  void known.list;
  return address ? byAddress.get(address) : undefined;
}

export function knownByName(name: string): KnownWallet | undefined {
  const n = name.trim().toLowerCase();
  return known.list.find((k) => k.name.toLowerCase() === n);
}

export async function startKnown() {
  const cached = load<{ at: number; list: KnownWallet[] }>(cacheKey());
  if (cached) use(clean(cached.list));
  if (cached && Date.now() - cached.at < TTL) return;
  try {
    const res = await fetch(SOURCE, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const list = clean(await res.json());
    if (!list.length) return;
    use(list);
    save(cacheKey(), { at: Date.now(), list });
  } catch {
    /* GitHub unreachable: keep the bundled or cached list */
  }
}
