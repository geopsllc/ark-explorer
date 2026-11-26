/**
 * Near-live chain state: the tip, recent blocks/transactions and the current round.
 *
 * Two sources, because the testnet's REST API runs one block behind (measured Nov 2026: block N
 * shows up there only once block N+1 is committed, ~8.7 s after N's timestamp, or much later
 * when N+1 needed extra consensus rounds):
 * - the node's JSON-RPC (eth_getBlockByNumber "latest") has a block 1-1.4 s after its timestamp.
 *   It is load-balanced over nodes that can be a block apart, so "latest" sometimes goes back
 *   one: older answers are ignored. The tip watcher polls shortly after the next block is due
 *   (+0.9, +1.3, +1.7, +2.2 s…),
 *   then every 1.5 s (later consensus rounds; ~18 s after a missed proposal, ~32 s after two, see
 *   chain.ts), slower once the chain looks stalled: ~20-30 requests/min, under the RPC limit.
 *   Those blocks only say number, hash, proposer and time; they are shown as provisional blocks
 *   of the round (`live.head`, the Forging View) until REST has them;
 * - REST (/blocks?number.from=<tip+1>) gives the full blocks (consensus round, fees,
 *   transactions). It is polled as soon as the tip watcher shows that REST has something new.
 *   Without RPC the poller falls back to its own schedule (a block reaches REST ~16 s after the
 *   one before it).
 *
 * Only one visible tab per browser polls (leader election over localStorage); it shares what it
 * gets with the other tabs over BroadcastChannel, so extra tabs cost no requests. Hidden tabs
 * stop polling and catch up when they become visible again.
 */
import { ApiError, get, RateLimitError, rpc } from "./api";
import { STORE } from "./site";
import { chain, initChain, roundArrivalMs, roundGraceMs, roundOf, roundOrder, roundStart } from "./chain";
import { checksum, mapBlock, mapTx } from "./ms";
import { addBlock, buildRound, cloneRound, inferRound, type RoundBlock, type RoundInfo } from "./roundview";
import { load, remove, save } from "./storage";
import { inBlock } from "./txinfo";
import type { Block, Transaction } from "./types";

export type LiveStatus = "connecting" | "live" | "delayed" | "offline" | "rate-limited";
export type { RoundInfo };

const KEEP_BLOCKS = 100;
const KEEP_TXS = 100;
/** RPC polls after the next block is due (head + 8 s); RPC has a block 1-1.4 s after its timestamp */
const HEAD_OFFSETS = [900, 1300, 1700, 2200, 2800, 3600, 5000, 7000];
/** REST fallback polls (no RPC) after the next block is due on REST (tip + 2 × 8 s: it lags a block) */
const POLL_OFFSETS = [700, 1200, 1700, 2300, 3000, 4000, 5500, 7000];
/** REST polls after the tip watcher saw REST should have more (it gets block N ~0.7 s after RPC has N+1) */
const CATCH_OFFSETS = [0, 600, 1300, 2500, 4000];

/** The newest block known: from RPC (ahead of REST), or the REST tip. */
export interface Head {
  height: number;
  /** timestamp, ms */
  ms: number;
  /** proposer address (EIP-55) */
  proposer: string;
  hash: string;
}

export const live = $state({
  /** newest block in the REST API (full data) */
  tip: null as Block | null,
  /** newest block known (RPC sees it ~8 s before REST): drives heights, timing and the round view */
  head: null as Head | null,
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
// RPC has a block 1-1.4 s after its timestamp (testnet, Nov 2026). If the arrival delay is far
// outside that the local clock is wrong; correct it so countdowns and "proposing now" stay right.
// (REST arrivals say nothing about the clock: they depend on when the NEXT block is committed.)
// Only tight samples count: the block must have been missing from a poll made shortly before the
// one that found it. A block that was simply fetched late (slow network, a busy or throttled tab)
// says nothing about the clock, and counting it would push the poll schedule later and later.
const delays: number[] = [];
const TIGHT_MS = 1500;
const EXPECTED_DELAY_MS = 1100;
function noteArrival(ms: number) {
  const d = Date.now() - ms;
  if (d < -120_000 || d > 120_000) return;
  delays.push(d);
  if (delays.length > 15) delays.shift();
  if (delays.length < 3) return;
  const sorted = [...delays].sort((a, b) => a - b);
  const skew = sorted[sorted.length >> 1] - EXPECTED_DELAY_MS;
  live.clockOffset = Math.abs(skew) > 2500 ? -skew : 0;
}
/** The last RPC poll that saw no new block: which height it waited for and when it was sent (local clock). */
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
  // provisional blocks REST now has are replaced by the real ones
  const tip = live.tip;
  for (const h of [...heads.keys()]) if (h <= tip.height) heads.delete(h);
  if (!live.head || tip.height >= live.head.height) {
    live.head = { height: tip.height, ms: tip.timestamp.unix * 1000, proposer: tip.generator.address, hash: tip.id };
  }
  // round bookkeeping
  for (const b of newer) {
    const r = restRound;
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

/** Blocks RPC has shown that REST does not have yet (height > live.tip), by height. */
const heads = new Map<number, Head>();

/** A newer block from RPC (or from the leader tab). */
function noteHead(list: Head[]) {
  const tipHeight = live.tip?.height ?? 0;
  let top = live.head;
  for (const h of list) {
    if (h.height > tipHeight) heads.set(h.height, h);
    if (!top || h.height > top.height) top = h;
  }
  if (top && top !== live.head) {
    live.head = top;
    live.lastSuccess = Date.now();
    if (live.status !== "live" && live.status !== "rate-limited") live.status = "live";
    syncRound().catch(() => {});
    kickRest();
  }
}

/**
 * The current round as REST blocks describe it (consensus rounds and re-proposals exact). What is
 * shown, `live.round`, is this plus the provisional RPC blocks after it.
 */
let restRound: RoundInfo | null = null;

function showRound() {
  if (!restRound) return;
  const r = cloneRound(restRound);
  for (let h = r.startHeight + r.count; r.count < chain.activeDelegates && roundOf(h) === r.number; h++) {
    const hd = heads.get(h);
    if (!hd) break;
    addBlock(r, { height: h, id: hd.hash, proposer: hd.proposer, round: inferRound(r, hd.proposer) });
  }
  live.round = r;
}

/** Make `live.round` describe the round of the next block (after the head). */
let roundLoading: Promise<void> | null = null;
async function syncRound(): Promise<void> {
  const tip = live.tip;
  if (!tip) return;
  const next = roundOf(Math.max(tip.height, live.head?.height ?? 0) + 1);
  const start = roundStart(next);
  if (restRound?.number === next && restRound.count === Math.max(0, tip.height - start + 1)) return showRound();
  if (roundLoading) return roundLoading;
  roundLoading = (async () => {
    try {
      const list = await roundOrder(next, "interactive");
      // the round's REST blocks up to the tip (at most 52)
      let blocks = live.blocks.filter((b) => b.height >= start);
      const tipNow = live.tip?.height ?? tip.height;
      if (tipNow >= start && blocks.length < tipNow - start + 1) {
        const body = await get(`/blocks?number.from=${start}&number.to=${tipNow}&orderBy=number:asc&limit=100`, "interactive");
        blocks = (body.data as any[]).map(mapBlock);
      }
      const r = buildRound(next, start, list, blocks.map(toRoundBlock));
      // blocks that arrived meanwhile
      for (const b of [...live.blocks].reverse()) if (b.height === r.startHeight + r.count && roundOf(b.height) === next) addBlock(r, toRoundBlock(b));
      if (!restRound || restRound.number <= next) restRound = r;
    } catch {
      /* the next round's order is not out yet: keep showing the last one */
    } finally {
      roundLoading = null;
    }
    showRound();
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
  restRound = null;
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

// ---------- the REST poller ----------
let lastPoll = 0;
let failures = 0;

/** Poll times after `base` (ms): tightly after `due` (base + offsets), then every 2 s (later
 * consensus rounds), every 5 s after 2 minutes and every 15 s after 10 (stalled). */
function schedule(base: number, firstDue: number, offsets: number[], fast = 2000): (now: number) => number {
  return (now) => {
    const due = base + firstDue;
    for (const o of offsets) if (due + o >= now) return due + o;
    const e = now - base;
    const step = e < 120_000 ? fast : e < 600_000 ? 5000 : 15_000;
    return base + Math.ceil(e / step) * step;
  };
}

function nextAt(at: (now: number) => number, after: number, now: number): number {
  let t = at(now);
  while (t <= after + 400) t = at(t + 1);
  return t;
}

/** REST should have more than it has shown: RPC is at least 2 blocks ahead of it (REST lags one). */
const restBehind = () => !!live.tip && !!live.head && live.head.height - 1 > live.tip.height;

/** RPC answers: REST polls follow the tip watcher instead of their own schedule. */
let rpcOk = false;
/** since when REST has been behind the head (to pace the catch-up polls) */
let behindSince = 0;

function nextPollAt(now: number): number {
  if (rpcOk) {
    if (!restBehind()) return now + 2000; // nothing to fetch yet: look again when woken or in 2 s
    behindSince ||= now;
    return nextAt(schedule(behindSince, 0, CATCH_OFFSETS), lastPoll, now);
  }
  // no RPC: REST shows a block ~16 s after the one before it (it waits for the next commit)
  return nextAt(schedule(live.tip!.timestamp.unix * 1000, 2 * chain.blocktime * 1000, POLL_OFFSETS), lastPoll, now);
}

async function poll(leader = true) {
  const tip = live.tip!;
  const from = tip.height + 1;
  if (leader) lastPoll = nowMs();
  const body = await get(`/blocks?number.from=${from}&orderBy=number:asc&limit=100`, "live");
  const blocks = (body.data as any[]).map(mapBlock);
  failures = 0;
  if (!blocks.length) {
    live.lastSuccess = Date.now();
    if (live.status !== "live") live.status = "live";
    return false;
  }
  const txs = (await Promise.all(blocks.map((b) => fetchBlockTxs(b, "live").catch(() => [] as Transaction[])))).flat();
  applyBlocks(blocks, txs);
  behindSince = restBehind() ? nowMs() : 0; // still behind: ask again right away
  channel?.postMessage({ type: "blocks", blocks, txs, clockOffset: live.clockOffset });
  return blocks.length === 100; // more to catch up
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a sleep that kickRest() can end early (the tip watcher saw REST should have a new block) */
let wakeRest: (() => void) | null = null;
const nap = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(() => ((wakeRest = null), r()), ms);
    wakeRest = () => (clearTimeout(t), (wakeRest = null), r());
  });
function kickRest() {
  if (restBehind()) wakeRest?.();
}
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
    const behind = restBehind();
    const at = nextPollAt(nowMs());
    let wait = at - nowMs();
    while (wait > 0 && live.leader && live.tip?.height === tipHeight && restBehind() === behind) {
      await nap(Math.min(wait, 2000)); // wake at least every 2 s to notice a lost leadership or a new tip
      wait = at - nowMs();
    }
    if (!live.leader || live.tip?.height !== tipHeight) continue;
    if (rpcOk && !restBehind()) continue; // woken for nothing, or RPC came back
    if (wait > 0) continue; // the REST lag state changed: plan again
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

// ---------- the tip watcher (JSON-RPC) ----------
const hexNum = (x: string) => Number(BigInt(x));
const toHead = (b: any): Head => ({
  height: hexNum(b.number),
  ms: hexNum(b.timestamp),
  proposer: checksum(b.miner),
  hash: String(b.hash).replace(/^0x/, ""),
});
const rpcBlock = async (tag: string): Promise<Head | null> => {
  const b = await rpc("eth_getBlockByNumber", [tag, false]);
  return b ? toHead(b) : null;
};

let lastHeadPoll = 0;
let rpcFailures = 0;

async function headLoop() {
  for (;;) {
    if (!live.leader || !live.tip) {
      await sleep(1000);
      continue;
    }
    const head = live.head ?? { height: live.tip.height, ms: live.tip.timestamp.unix * 1000 };
    const at = nextAt(schedule(head.ms, chain.blocktime * 1000, HEAD_OFFSETS, 1500), lastHeadPoll, nowMs());
    let wait = at - nowMs();
    while (wait > 0 && live.leader && (live.head?.height ?? 0) <= head.height) {
      await sleep(Math.min(wait, 2000));
      wait = at - nowMs();
    }
    if (!live.leader || (live.head?.height ?? 0) > head.height) continue; // another tab told us
    const sent = Date.now();
    lastHeadPoll = nowMs();
    try {
      const top = await rpcBlock("latest");
      rpcFailures = 0;
      rpcOk = true;
      live.lastSuccess = Date.now();
      if (!top || top.height <= head.height) {
        lastEmpty = { height: head.height + 1, at: sent };
        continue;
      }
      // one new block that a poll just before had not seen: a tight measure of when it appeared
      if (top.height === head.height + 1 && lastEmpty.height === top.height && sent - lastEmpty.at <= TIGHT_MS) noteArrival(top.ms);
      // blocks skipped between two polls (rare): their proposers place the round's turns
      const got = [top];
      const from = Math.max(head.height, live.tip.height) + 1;
      for (let h = Math.max(from, top.height - 4); h < top.height; h++) {
        if (heads.has(h)) continue;
        const b = await rpcBlock("0x" + h.toString(16)).catch(() => null);
        if (b) got.push(b);
      }
      noteHead(got);
      channel?.postMessage({ type: "head", heads: got, clockOffset: live.clockOffset });
    } catch (e: any) {
      rpcFailures++;
      // REST takes over (its own schedule) until RPC answers again
      if (e instanceof RateLimitError || rpcFailures >= 3) rpcOk = false;
      wakeRest?.();
      if (e instanceof RateLimitError) await sleep(e.seconds * 1000);
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
      if (live.leader) return;
      if (m?.type === "head") {
        if (typeof m.clockOffset === "number") live.clockOffset = m.clockOffset;
        noteHead(m.heads as Head[]);
        return;
      }
      if (m?.type !== "blocks") return;
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

  // followers stay fresh even if the leader's messages are missed (REST is always a block behind)
  setInterval(() => {
    if (!live.leader && !document.hidden && live.tip && nowMs() - live.tip.timestamp.unix * 1000 > 6 * chain.blocktime * 1000) {
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
  headLoop();
}

// ---------- proposal turns (Forging View) ----------

/** Timestamp (ms) of the newest block known. */
const headMs = () => live.head?.ms ?? (live.tip?.timestamp.unix ?? 0) * 1000;

/** Consensus round the next block number is most likely in now, from the time since the head. */
function roundInProgress(now: number): number {
  if (!live.head) return 0;
  const e = now - headMs();
  let r = 0;
  // a round counts as over a little after its block would have shown up
  while (r < 1000 && roundArrivalMs(r) + roundGraceMs(r) < e) r++;
  return r;
}

/** The turn being proposed now (see roundview.ts), and when later turns are expected. */
export function currentSlot(now: number): number {
  return (live.round?.nextSlot ?? 0) + roundInProgress(now);
}

/** Expected time (ms, corrected clock) turn `slot` starts, assuming every turn before it succeeds. */
export function slotStartMs(slot: number, now: number): number {
  const tipMs = headMs();
  const r = roundInProgress(now);
  const cur = (live.round?.nextSlot ?? 0) + r;
  if (slot <= cur) return tipMs + (r ? roundArrivalMs(r - 1) : 0);
  return tipMs + roundArrivalMs(r) + (slot - cur - 1) * chain.blocktime * 1000;
}

export { chain };
