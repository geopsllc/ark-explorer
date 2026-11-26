/**
 * Round and proposer math for Mainsail (ARK's BFT chain), matching the node
 * (ArkEcosystem/mainsail: blockchain-utils round-calculator + proposer-calculator, validator-set):
 *
 * - A round is `roundValidators` (53) BLOCKS. Round 1 starts at the block after genesis, so
 *   round(height) = floor((height - genesis - 1) / 53) + 1. The testnet's genesis is the ARK
 *   devnet snapshot it started from, so it is read from the API once (the first block).
 * - Each block number is decided by consensus rounds 0, 1, 2…; the proposer of consensus round r
 *   is roundValidators[(totalRound + r) % 53], where totalRound grows by (commit round + 1) with
 *   every block. A block's `round` is the consensus round it was proposed in, so `round` > 0
 *   means the proposers of rounds 0…round-1 missed (the node's own ProposerReporter counts misses
 *   the same way).
 * - The API stores each round's validators in proposal order (`/rounds/{n}`). Some stored rounds
 *   start at another point of the rotation, so the order is calibrated from real proposers
 *   (roundview.ts) instead of trusted as is.
 */
import type { Priority } from "./api";
import { get } from "./api";
import { load, save } from "./storage";
import { STORE } from "./site";

/** Mainsail testnet constants (/node/configuration: blockTime 8000, roundValidators 53). */
export const chain = {
  blocktime: 8,
  activeDelegates: 53,
  /** height of the genesis block (set by initChain) */
  genesis: 0,
} as const as { blocktime: number; activeDelegates: number; genesis: number };

export const roundOf = (height: number) => Math.floor((height - chain.genesis - 1) / chain.activeDelegates) + 1;
export const roundStart = (round: number) => chain.genesis + 1 + (round - 1) * chain.activeDelegates;

/**
 * When a block proposed in consensus round r shows up, measured from the previous block's
 * timestamp (testnet, Nov 2026: round 0 ~8 s, 1 ~18 s, 2 ~32 s, 3 ~50 s, 4 ~70 s; the node waits
 * blockTime, then each round's propose / prevote / precommit timeouts grow by 2 s).
 */
export const roundArrivalMs = (r: number) => 8000 + 10_000 * r + 2000 * r * Math.max(0, r - 1);

let initing: Promise<void> | null = null;
/** Read the genesis height (cached: it never changes). */
export function initChain(priority: Priority = "interactive"): Promise<void> {
  if (chain.genesis) return Promise.resolve();
  const key = `${STORE}:genesis`;
  const cached = load<number>(key);
  if (cached) {
    chain.genesis = cached;
    return Promise.resolve();
  }
  initing ??= get("/blocks?limit=1&orderBy=number:asc", priority)
    .then((body) => {
      const h = Number(body.data?.[0]?.number);
      if (!h) throw new Error("Could not read the first block");
      chain.genesis = h;
      save(key, h);
    })
    .finally(() => (initing = null));
  return initing;
}

const orderCache = new Map<number, Promise<string[]>>();
const storeKey = `${STORE}:rounds`;
const KEEP_ROUNDS = 250;

function remember(rounds: [number, string[]][]) {
  const all = load<Record<string, string[]>>(storeKey) ?? {};
  for (const [round, list] of rounds) {
    if (!orderCache.has(round)) orderCache.set(round, Promise.resolve(list));
    all[round] = list;
  }
  const keys = Object.keys(all).map(Number).sort((a, b) => b - a);
  for (const k of keys.slice(KEEP_ROUNDS)) delete all[k];
  save(storeKey, all);
}

/**
 * Validators of `round` in the API's proposal order (addresses). Immutable once the round exists,
 * so cached (memory + localStorage for the last 250 rounds). `latest` (the newest round there is)
 * lets a miss fetch the whole /rounds page around it: 100 rounds per request instead of one.
 */
export function roundOrder(round: number, priority: Priority = "interactive", latest = 0): Promise<string[]> {
  const hit = orderCache.get(round);
  if (hit) return hit;
  const stored = load<Record<string, string[]>>(storeKey)?.[round];
  if (stored) {
    const p = Promise.resolve(stored);
    orderCache.set(round, p);
    return p;
  }
  const one = () =>
    get(`/rounds/${round}`, priority).then((body) => {
      const list = (body.data?.validators ?? []) as string[];
      if (list.length !== chain.activeDelegates) throw new Error(`Round ${round} is not available yet`);
      return list;
    });
  const p = (async () => {
    if (latest > round + 1) {
      // newest first, 100 per page
      const page = Math.floor((latest - round) / 100) + 1;
      const body = await get(`/rounds?limit=100&page=${page}`, priority);
      const rows = (body.data ?? []) as { round: string; validators: string[] }[];
      remember(rows.filter((r) => r.validators?.length === chain.activeDelegates).map((r) => [Number(r.round), r.validators]));
      const found = rows.find((r) => Number(r.round) === round);
      if (found) return found.validators;
    }
    const list = await one();
    remember([[round, list]]);
    return list;
  })();
  p.catch(() => orderCache.delete(round));
  orderCache.set(round, p);
  return p;
}
