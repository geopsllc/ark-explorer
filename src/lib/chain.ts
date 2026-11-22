/**
 * Slot, round and forging-order math, matching ARK Core 3.13 exactly:
 *
 * - slot = floor(epochSeconds / blocktime); the slot's forger is order[slot % activeDelegates]
 *   (core-kernel calculate-forging-info; mainnet never changed activeDelegates or blocktime).
 * - round(height) = floor((height - 1) / activeDelegates) + 1 (core-kernel round-calculator).
 * - order = the round's delegates sorted by vote balance desc (public key asc on ties), shuffled
 *   with a seed of sha256(round number as a string), re-hashed after every 4 swaps. Note the
 *   outer loop's own i++, which skips one index per group (core-state round-state shuffleDelegates).
 *
 * Verified against mainnet: 51/51 blocks of a full round matched.
 */
import { get } from "./api";
import { sha256 } from "./sha256";
import { load, save } from "./storage";
import { STORE } from "./site";

/** ARK mainnet constants (never changed since genesis: 51 delegates, 8 s blocks). */
export const chain = {
  epochMs: Date.UTC(2017, 2, 21, 13, 0, 0),
  blocktime: 8,
  activeDelegates: 51,
} as const;

export const slotOf = (epochSeconds: number) => Math.floor(epochSeconds / chain.blocktime);
export const slotStartMs = (slot: number) => chain.epochMs + slot * chain.blocktime * 1000;
export const slotAt = (ms: number) => Math.floor((ms - chain.epochMs) / 1000 / chain.blocktime);
export const roundOf = (height: number) => Math.floor((height - 1) / chain.activeDelegates) + 1;
export const roundStart = (round: number) => (round - 1) * chain.activeDelegates + 1;

function shuffle(publicKeys: string[], round: number): string[] {
  const d = [...publicKeys];
  let seed = sha256(new TextEncoder().encode(String(round)));
  for (let i = 0, n = d.length; i < n; i++) {
    for (let x = 0; x < 4 && i < n; i++, x++) {
      const k = seed[x] % n;
      const b = d[k];
      d[k] = d[i];
      d[i] = b;
    }
    seed = sha256(seed);
  }
  return d;
}

const orderCache = new Map<number, Promise<string[]>>();

/**
 * Forging order of `round`: index i forges the slots where slot % activeDelegates === i.
 * Immutable once the round exists, so it is cached (memory + localStorage for the last 120 rounds).
 */
export function roundOrder(round: number, priority: "interactive" | "live" | "background" = "interactive"): Promise<string[]> {
  const hit = orderCache.get(round);
  if (hit) return hit;
  const storeKey = `${STORE}:orders`;
  const stored = load<Record<string, string[]>>(storeKey) ?? {};
  if (stored[round]) {
    const p = Promise.resolve(stored[round]);
    orderCache.set(round, p);
    return p;
  }
  const p = get(`/rounds/${round}/delegates`, priority).then((body) => {
    const list = (body.data as { publicKey: string; votes: string }[]).slice();
    if (list.length !== chain.activeDelegates) throw new Error(`Round ${round} is not available yet`);
    list.sort((a, b) => {
      const v = BigInt(b.votes) - BigInt(a.votes);
      if (v !== 0n) return v > 0n ? 1 : -1;
      return a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0;
    });
    const order = shuffle(list.map((x) => x.publicKey), round);
    const all = load<Record<string, string[]>>(storeKey) ?? {};
    all[round] = order;
    const keys = Object.keys(all).map(Number).sort((a, b) => b - a);
    for (const k of keys.slice(120)) delete all[k];
    save(storeKey, all);
    return order;
  });
  p.catch(() => orderCache.delete(round));
  orderCache.set(round, p);
  return p;
}
