/**
 * Near-live chain state: the tip, recent blocks/transactions and the current round.
 *
 * Polling is slot-aware instead of fixed-interval. Measured on api.ark.io, a new block becomes
 * visible 0.8-1.8 s after its slot starts, so the poller sleeps until the next slot + 0.7 s and
 * then checks at +1.2, +1.7, +2.3, +3, +4, +5.5, +7 s until the block shows up. Normally that is
 * 2-3 requests per 8 s block (~20/min) and a block is on screen ~1-2 s after it is forged.
 * Each poll is a single height-range query (/blocks?height.from=<tip+1>, ~0.2 s) that returns the
 * new blocks themselves, so there is no "check tip, then fetch block" round trip.
 *
 * Only one visible tab per browser polls (leader election over localStorage); it shares what it
 * gets with the other tabs over BroadcastChannel, so extra tabs cost no requests. Hidden tabs
 * stop polling and catch up when they become visible again.
 */
import { ApiError, get, RateLimitError } from "./api";
import { STORE } from "./site";
import { chain, roundOf, roundOrder, roundStart, slotAt, slotOf, slotStartMs } from "./chain";
import { load, remove, save } from "./storage";
import type { Block, Transaction } from "./types";

export type LiveStatus = "connecting" | "live" | "delayed" | "offline" | "rate-limited";

export interface RoundInfo {
  number: number;
  startHeight: number;
  /** first slot of the round = slot of the previous round's last block + 1 */
  firstSlot: number;
  /** order[i] forges slots where slot % activeDelegates === i */
  order: string[];
  /** blocks of this round by slot */
  forged: Record<number, { height: number; id: string; publicKey: string }>;
  count: number;
}

const KEEP_BLOCKS = 100;
const KEEP_TXS = 100;
const POLL_OFFSETS = [700, 1200, 1700, 2300, 3000, 4000, 5500, 7000];
const STALLED_OFFSETS = [1000, 3000, 6000];

export const live = $state({
  tip: null as Block | null,
  blocks: [] as Block[],
  txs: [] as Transaction[],
  round: null as RoundInfo | null,
  status: "connecting" as LiveStatus,
  error: "",
  leader: false,
  /** corrected wall clock in ms, ticks every 500 ms */
  now: Date.now(),
  clockOffset: 0,
  lastSuccess: 0,
});

type Listener = (blocks: Block[], txs: Transaction[]) => void;
const listeners = new Set<Listener>();
/** Called with every batch of new blocks (oldest first) and their transactions. */
export function onNewBlocks(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const nowMs = () => Date.now() + live.clockOffset;

// ---------- clock correction ----------
// Blocks normally show up 0.8-1.8 s after their slot starts. If the arrival delay is far outside
// that range the local clock is wrong; correct it so countdowns and "forging now" stay right.
const delays: number[] = [];
function noteArrival(b: Block) {
  const d = Date.now() - b.timestamp.unix * 1000;
  if (d < -120_000 || d > 120_000) return; // catch-up, not a fresh block
  delays.push(d);
  if (delays.length > 15) delays.shift();
  if (delays.length < 3) return;
  const sorted = [...delays].sort((a, b) => a - b);
  const skew = sorted[sorted.length >> 1] - 1200;
  live.clockOffset = Math.abs(skew) > 2500 ? -skew : 0;
}

// ---------- applying blocks ----------
function txsFrom(block: Block, txs: Transaction[]) {
  for (const t of txs) t.height = block.height;
  return txs;
}

async function fetchBlockTxs(b: Block, priority: "live" | "interactive"): Promise<Transaction[]> {
  if (!b.transactions) return [];
  const out: Transaction[] = [];
  for (let page = 1; out.length < b.transactions && page <= 3; page++) {
    const body = await get(`/blocks/${b.id}/transactions?page=${page}&limit=100`, priority);
    out.push(...(body.data as Transaction[]));
    if ((body.data as any[]).length < 100) break;
  }
  return txsFrom(b, out);
}

function applyBlocks(blocks: Block[], txs: Transaction[], fresh: boolean, notify = true) {
  if (!blocks.length) return;
  blocks.sort((a, b) => a.height - b.height);
  const tipHeight = live.tip?.height ?? 0;
  const newer = blocks.filter((b) => b.height > tipHeight);
  if (!newer.length) return;
  live.tip = newer[newer.length - 1];
  live.blocks = [...newer.slice().reverse(), ...live.blocks].slice(0, KEEP_BLOCKS);
  const ids = new Set(newer.map((b) => b.id));
  const newTxs = txs.filter((t) => ids.has(t.blockId)).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  if (newTxs.length) live.txs = [...newTxs, ...live.txs].slice(0, KEEP_TXS);
  if (fresh) noteArrival(live.tip);
  live.lastSuccess = Date.now();
  live.status = "live";
  live.error = "";
  // round bookkeeping
  for (const b of newer) {
    const r = live.round;
    if (r && roundOf(b.height) === r.number) {
      r.forged[slotOf(b.timestamp.epoch)] = { height: b.height, id: b.id, publicKey: b.generator.publicKey };
      r.count++;
    }
  }
  syncRound().catch(() => {});
  // the initial/catch-up window is state, not news: pages would otherwise all reload at start
  if (!notify) return;
  for (const fn of listeners) {
    try {
      fn(newer, newTxs);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Make `live.round` describe the round of the next block. */
let roundLoading: Promise<void> | null = null;
async function syncRound(): Promise<void> {
  const tip = live.tip;
  if (!tip) return;
  const next = roundOf(tip.height + 1);
  if (live.round?.number === next) return;
  if (roundLoading) return roundLoading;
  roundLoading = (async () => {
    try {
      const start = roundStart(next);
      const order = await roundOrder(next, "interactive");
      // blocks from the previous round's last block up to the tip (at most 52)
      let blocks = live.blocks.filter((b) => b.height >= start - 1);
      if (!blocks.some((b) => b.height === start - 1) && start > 1) {
        const body = await get(`/blocks?height.from=${start - 1}&height.to=${tip.height}&orderBy=height:asc&limit=100`, "interactive");
        blocks = body.data as Block[];
      }
      const prev = blocks.find((b) => b.height === start - 1);
      const firstSlot = prev ? slotOf(prev.timestamp.epoch) + 1 : slotOf(tip.timestamp.epoch) + 1;
      const forged: RoundInfo["forged"] = {};
      let count = 0;
      for (const b of blocks) {
        if (b.height >= start) {
          forged[slotOf(b.timestamp.epoch)] = { height: b.height, id: b.id, publicKey: b.generator.publicKey };
          count++;
        }
      }
      if (roundOf((live.tip?.height ?? tip.height) + 1) === next) live.round = { number: next, startHeight: start, firstSlot, order, forged, count };
    } finally {
      roundLoading = null;
    }
  })();
  return roundLoading;
}

// ---------- initial load / resync ----------
async function resync(priority: "interactive" | "live" = "interactive") {
  const body = await get("/blockchain", priority);
  const h: number = body.data.block.height;
  const blocks = (await get(`/blocks?height.from=${Math.max(1, h - KEEP_BLOCKS + 1)}&height.to=${h}&orderBy=height:asc&limit=100`, priority)).data as Block[];
  live.tip = null;
  live.blocks = [];
  live.round = null;
  applyBlocks(blocks, [], false, false);
  // transactions of the last few blocks so the live list is not empty
  const withTxs = live.blocks.filter((b) => b.transactions > 0).slice(0, 4);
  const txs = (await Promise.all(withTxs.map((b) => fetchBlockTxs(b, priority).catch(() => [])))).flat();
  if (txs.length) live.txs = txs.sort((a, b) => (b.height ?? 0) - (a.height ?? 0)).slice(0, KEEP_TXS);
}

// ---------- leader election (one polling tab per browser) ----------
const tabId = Math.random().toString(36).slice(2);
const leaderKey = () => `${STORE}:leader`;
let channel: BroadcastChannel | null = null;

function electLeader() {
  if (!channel) {
    live.leader = !document.hidden;
    return;
  }
  const now = Date.now();
  const cur = load<{ id: string; ts: number }>(leaderKey());
  if (document.hidden) {
    if (cur?.id === tabId) remove(leaderKey());
    live.leader = false;
    return;
  }
  if (!cur || cur.id === tabId || now - cur.ts > 5000) {
    save(leaderKey(), { id: tabId, ts: now });
    live.leader = load<{ id: string }>(leaderKey())?.id === tabId;
  } else {
    live.leader = false;
  }
}

// ---------- the poller ----------
let lastPoll = 0;
let failures = 0;

function nextPollAt(now: number): number {
  const tip = live.tip!;
  const tipSlot = slotOf(tip.timestamp.epoch);
  let target = Math.max(tipSlot + 1, slotAt(now));
  for (;;) {
    const base = slotStartMs(target);
    const offsets = target - tipSlot > 3 ? STALLED_OFFSETS : POLL_OFFSETS;
    for (const o of offsets) {
      const t = base + o;
      if (t >= now && t > lastPoll + 400) return t;
    }
    target++;
  }
}

async function poll() {
  const tip = live.tip!;
  lastPoll = nowMs();
  const body = await get(`/blocks?height.from=${tip.height + 1}&orderBy=height:asc&limit=100`, "live");
  const blocks = body.data as Block[];
  failures = 0;
  if (!blocks.length) {
    live.lastSuccess = Date.now();
    if (live.status !== "live") live.status = "live";
    return false;
  }
  const txs = (await Promise.all(blocks.map((b) => fetchBlockTxs(b, "live").catch(() => [] as Transaction[])))).flat();
  applyBlocks(blocks, txs, blocks.length < 5);
  channel?.postMessage({ type: "blocks", blocks, txs });
  return blocks.length === 100; // more to catch up
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = false;

async function loop() {
  for (;;) {
    if (!live.leader || !live.tip) {
      await sleep(1000);
      continue;
    }
    // back after a long sleep (hidden tab, laptop lid): reload the recent window
    if (slotAt(nowMs()) - slotOf(live.tip.timestamp.epoch) > KEEP_BLOCKS) {
      try {
        await resync("live");
      } catch {
        await sleep(3000);
      }
      continue;
    }
    const wait = nextPollAt(nowMs()) - nowMs();
    if (wait > 0) await sleep(Math.min(wait, 2000)); // re-evaluate at least every 2 s
    if (!live.leader || nextPollAt(nowMs()) - nowMs() > 60) continue;
    try {
      const more = await poll();
      if (more) lastPoll = 0;
    } catch (e: any) {
      failures++;
      if (e instanceof RateLimitError) {
        live.status = "rate-limited";
        live.error = e.message;
        await sleep(Math.min(10_000, e.seconds * 1000));
      } else {
        live.status = failures >= 4 ? "offline" : "delayed";
        live.error = e instanceof ApiError ? e.message : String(e);
      }
    }
  }
}

export async function startLive() {
  if (running) return;
  running = true;
  setInterval(() => {
    live.now = nowMs();
    if (live.status === "live" && Date.now() - live.lastSuccess > 20_000) live.status = "delayed";
  }, 500);

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("ark-explorer");
    channel.onmessage = (ev) => {
      const m = ev.data;
      if (m?.type !== "blocks" || live.leader) return;
      const blocks = m.blocks as Block[];
      const first = blocks.reduce((a, b) => Math.min(a, b.height), Infinity);
      if (live.tip && first > live.tip.height + 1) {
        resync("live").catch(() => {});
        return;
      }
      applyBlocks(blocks, m.txs as Transaction[], blocks.length < 5);
    };
  }
  electLeader();
  setInterval(electLeader, 2000);
  document.addEventListener("visibilitychange", electLeader);
  window.addEventListener("pagehide", () => {
    if (load<{ id: string }>(leaderKey())?.id === tabId) remove(leaderKey());
  });

  // followers stay fresh even if the leader's messages are missed
  setInterval(() => {
    if (!live.leader && !document.hidden && live.tip && slotAt(nowMs()) - slotOf(live.tip.timestamp.epoch) > 4) {
      poll().catch(() => {});
    }
  }, 8000);

  for (let attempt = 0; ; attempt++) {
    try {
      await resync();
      break;
    } catch (e: any) {
      live.status = e instanceof RateLimitError ? "rate-limited" : "offline";
      live.error = e?.message ?? String(e);
      await sleep(Math.min(15_000, 2000 * (attempt + 1)));
    }
  }
  loop();
}

/** Expected start time (ms, corrected clock) of `slot`. */
export const slotTime = (slot: number) => slotStartMs(slot);
export { chain };
