/**
 * Near-live chain state: the tip, recent blocks/transactions and the current round.
 *
 * Polling follows the chain's rhythm instead of a fixed interval. Mainsail commits a block about
 * every 8 s; when a proposer misses, the next consensus round takes longer (a block from round 1
 * shows up ~18 s after the previous one, round 2 ~32 s, see chain.ts). So the poller checks
 * shortly after the block is due (+0.7, +1.2, +1.7, +2.3, +3, +4, +5.5, +7 s), then every 2 s,
 * slower once the chain looks stalled. Each poll is a single block-range query
 * (/blocks?number.from=<tip+1>) that returns the new blocks themselves.
 *
 * Only one visible tab per browser polls (leader election over localStorage); it shares what it
 * gets with the other tabs over BroadcastChannel, so extra tabs cost no requests. Hidden tabs
 * stop polling and catch up when they become visible again.
 */
import { ApiError, get, RateLimitError } from "./api";
import { STORE } from "./site";
import { chain, initChain, roundArrivalMs, roundOf, roundOrder, roundStart } from "./chain";
import { mapBlock, mapTx } from "./ms";
import { addBlock, buildRound, type RoundBlock, type RoundInfo } from "./roundview";
import { load, remove, save } from "./storage";
import { inBlock } from "./txinfo";
import type { Block, Transaction } from "./types";

export type LiveStatus = "connecting" | "live" | "delayed" | "offline" | "rate-limited";
export type { RoundInfo };

const KEEP_BLOCKS = 100;
const KEEP_TXS = 100;
/** after the block is due (tip + 8 s) */
const POLL_OFFSETS = [700, 1200, 1700, 2300, 3000, 4000, 5500, 7000];

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
  /** total supply in arktoshi, as of supplyHeight; kept current by adding each new block's reward */
  supply: null as bigint | null,
  supplyHeight: 0,
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
// Blocks are expected to show up ~0.8-1.8 s after their timestamp (measured on ARK Core; to be
// confirmed on Mainsail once the testnet runs again). If the arrival delay is far outside
// that range the local clock is wrong; correct it so countdowns and "forging now" stay right.
// Only tight samples count: the block must have been missing from a poll made shortly before the
// one that found it. A block that was simply fetched late (slow network, a busy or throttled tab)
// says nothing about the clock, and counting it would push the poll schedule later and later.
const delays: number[] = [];
const TIGHT_MS = 1500;
function noteArrival(b: Block) {
  const d = Date.now() - b.timestamp.unix * 1000;
  if (d < -120_000 || d > 120_000) return;
  delays.push(d);
  if (delays.length > 15) delays.shift();
  if (delays.length < 3) return;
  const sorted = [...delays].sort((a, b) => a - b);
  const skew = sorted[sorted.length >> 1] - 1200;
  live.clockOffset = Math.abs(skew) > 2500 ? -skew : 0;
}
/** The last poll that came back empty: which height it asked for and when it was sent (local clock). */
let lastEmpty = { height: 0, at: 0 };

// ---------- applying blocks ----------

async function fetchBlockTxs(b: Block, priority: "live" | "interactive"): Promise<Transaction[]> {
  if (!b.transactions) return [];
  const out: Transaction[] = [];
  for (let page = 1; out.length < b.transactions && page <= 3; page++) {
    const body = await get(`/blocks/${b.id}/transactions?page=${page}&limit=100`, priority);
    out.push(...(body.data as any[]).map(mapTx));
    if ((body.data as any[]).length < 100) break;
  }
  return inBlock(out, b);
}

function applyBlocks(blocks: Block[], txs: Transaction[], notify = true) {
  if (!blocks.length) return;
  blocks.sort((a, b) => a.height - b.height);
  const tipHeight = live.tip?.height ?? 0;
  const newer = blocks.filter((b) => b.height > tipHeight);
  if (!newer.length) return;
  live.tip = newer[newer.length - 1];
  if (live.supply !== null) {
    for (const b of newer) {
      if (b.height > live.supplyHeight) {
        live.supply += BigInt(b.forged.reward);
        live.supplyHeight = b.height;
      }
    }
  }
  live.blocks = [...newer.slice().reverse(), ...live.blocks].slice(0, KEEP_BLOCKS);
  const ids = new Set(newer.map((b) => b.id));
  const newTxs = txs.filter((t) => ids.has(t.blockId)).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  if (newTxs.length) live.txs = [...newTxs, ...live.txs].slice(0, KEEP_TXS);
  live.lastSuccess = Date.now();
  live.status = "live";
  live.error = "";
  // round bookkeeping
  for (const b of newer) {
    const r = live.round;
    if (r && roundOf(b.height) === r.number && b.height === r.startHeight + r.count) addBlock(r, toRoundBlock(b));
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

const toRoundBlock = (b: Block): RoundBlock => ({ height: b.height, id: b.id, proposer: b.generator.address, round: b.round });

/** Make `live.round` describe the round of the next block. */
let roundLoading: Promise<void> | null = null;
async function syncRound(): Promise<void> {
  const tip = live.tip;
  if (!tip) return;
  const next = roundOf(tip.height + 1);
  if (live.round?.number === next && live.round.startHeight + live.round.count === tip.height + 1) return;
  if (roundLoading) return roundLoading;
  roundLoading = (async () => {
    try {
      const start = roundStart(next);
      const list = await roundOrder(next, "interactive");
      // the round's blocks up to the tip (at most 52)
      let blocks = live.blocks.filter((b) => b.height >= start);
      const tipNow = live.tip?.height ?? tip.height;
      if (blocks.length < tipNow - start + 1) {
        const body = await get(`/blocks?number.from=${start}&number.to=${tipNow}&orderBy=number:asc&limit=100`, "interactive");
        blocks = (body.data as any[]).map(mapBlock);
      }
      const r = buildRound(next, start, list, blocks.map(toRoundBlock));
      // blocks that arrived meanwhile
      for (const b of [...live.blocks].reverse()) if (b.height === r.startHeight + r.count && roundOf(b.height) === next) addBlock(r, toRoundBlock(b));
      if (roundOf((live.tip?.height ?? tip.height) + 1) === next) live.round = r;
    } finally {
      roundLoading = null;
    }
  })();
  return roundLoading;
}

// ---------- initial load / resync ----------
async function resync(priority: "interactive" | "live" = "interactive") {
  await initChain(priority);
  const body = await get("/blockchain", priority);
  const h: number = Number(body.data.block.number);
  if (body.data.supply) {
    live.supply = BigInt(body.data.supply);
    live.supplyHeight = h;
  }
  const blocks = ((await get(`/blocks?number.from=${Math.max(1, h - KEEP_BLOCKS + 1)}&number.to=${h}&orderBy=number:asc&limit=100`, priority)).data as any[]).map(mapBlock);
  live.tip = null;
  live.blocks = [];
  live.round = null;
  applyBlocks(blocks, [], false);
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

/** When the poller checks for the block after `tipMs`: first tightly around when it is due, then
 * every 2 s (later consensus rounds), every 5 s after 2 minutes and every 15 s after 10 (stalled). */
function pollTimes(tipMs: number): (now: number) => number {
  return (now) => {
    const due = tipMs + chain.blocktime * 1000;
    for (const o of POLL_OFFSETS) if (due + o >= now) return due + o;
    const e = now - tipMs;
    const step = e < 120_000 ? 2000 : e < 600_000 ? 5000 : 15_000;
    return tipMs + Math.ceil(e / step) * step;
  };
}

function nextPollAt(now: number): number {
  const at = pollTimes(live.tip!.timestamp.unix * 1000);
  let t = at(now);
  while (t <= lastPoll + 400) t = at(t + 1);
  return t;
}

async function poll(leader = true) {
  const tip = live.tip!;
  const from = tip.height + 1;
  const sent = Date.now();
  if (leader) lastPoll = nowMs();
  const body = await get(`/blocks?number.from=${from}&orderBy=number:asc&limit=100`, "live");
  const blocks = (body.data as any[]).map(mapBlock);
  failures = 0;
  if (!blocks.length) {
    lastEmpty = { height: from, at: sent };
    live.lastSuccess = Date.now();
    if (live.status !== "live") live.status = "live";
    return false;
  }
  // one new block that a poll just before had not seen: a tight measure of when it appeared
  if (leader && blocks.length === 1 && lastEmpty.height === from && sent - lastEmpty.at <= TIGHT_MS) noteArrival(blocks[0]);
  const txs = (await Promise.all(blocks.map((b) => fetchBlockTxs(b, "live").catch(() => [] as Transaction[])))).flat();
  applyBlocks(blocks, txs);
  channel?.postMessage({ type: "blocks", blocks, txs, clockOffset: live.clockOffset });
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
    if (live.lastSuccess && Date.now() - live.lastSuccess > KEEP_BLOCKS * chain.blocktime * 1000) {
      try {
        await resync("live");
      } catch {
        await sleep(3000);
      }
      continue;
    }
    // Sleep until the planned poll, then poll. (Asking for the next poll time again after waking
    // would skip it: a timer always fires a little after its target, so the poll time has passed.)
    const tipHeight = live.tip.height;
    const at = nextPollAt(nowMs());
    let wait = at - nowMs();
    while (wait > 0 && live.leader && live.tip?.height === tipHeight) {
      await sleep(Math.min(wait, 2000)); // wake at least every 2 s to notice a lost leadership or a new tip
      wait = at - nowMs();
    }
    if (!live.leader || live.tip?.height !== tipHeight) continue;
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
      if (typeof m.clockOffset === "number") live.clockOffset = m.clockOffset; // the leader measures the clock
      applyBlocks(blocks, m.txs as Transaction[]);
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
    if (!live.leader && !document.hidden && live.tip && nowMs() - live.tip.timestamp.unix * 1000 > 4 * chain.blocktime * 1000) {
      poll(false).catch(() => {});
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

// ---------- proposal turns (Forging View) ----------

/** Consensus round the next block number is most likely in now, from the time since the tip. */
function roundInProgress(now: number): number {
  if (!live.tip) return 0;
  const e = now - live.tip.timestamp.unix * 1000;
  let r = 0;
  // a round counts as over a little after its block would have shown up
  while (r < 1000 && roundArrivalMs(r) + 2000 < e) r++;
  return r;
}

/** The turn being proposed now (see roundview.ts), and when later turns are expected. */
export function currentSlot(now: number): number {
  return (live.round?.nextSlot ?? 0) + roundInProgress(now);
}

/** Expected time (ms, corrected clock) turn `slot` starts, assuming every turn before it succeeds. */
export function slotStartMs(slot: number, now: number): number {
  const tipMs = (live.tip?.timestamp.unix ?? 0) * 1000;
  const r = roundInProgress(now);
  const cur = (live.round?.nextSlot ?? 0) + r;
  if (slot <= cur) return tipMs + (r ? roundArrivalMs(r - 1) : 0);
  return tipMs + roundArrivalMs(r) + (slot - cur - 1) * chain.blocktime * 1000;
}

export { chain };
