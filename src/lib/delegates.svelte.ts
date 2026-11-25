/**
 * Delegate directory, voter counts and missed-block tracking.
 *
 * Request plan (the public API allows 200 requests/min per IP):
 * - Directory: ~14 pages of 100. Page 1 (ranks 1-100) is loaded first and refreshed once per
 *   round; the rest load in the background and refresh every 30 min. Produced blocks and last
 *   block are updated locally from live blocks, so they are exact between refreshes.
 * - Voter counts (voters with >= 1 ARK): the API has no bulk form, so it is one
 *   `/delegates/{pk}/voters?limit=1&balance.from=1e8` per delegate on screen, 6 at a time, in screen
 *   order, cached for 30 min (51 counts take a few seconds).
 * - Missed blocks: the API has no missed-block data, so it is derived from block timestamps: a
 *   gap between two consecutive blocks means the slots in between were missed, and the forging
 *   order says by whom. The last MISSED_WINDOW_HOURS (24) are scanned once, 100 blocks per request
 *   (~108 requests for 24 h, background priority), then kept current from live blocks and cached,
 *   so a returning visitor only scans what is new.
 */
import { get } from "./api";
import { MISSED_WINDOW_HOURS, STORE } from "./site";
import { chain, roundOf, roundOrder, slotAt, slotOf } from "./chain";
import { healthFromStreak } from "./roundview";
import { live, nowMs, onNewBlocks } from "./live.svelte";
import { load, save } from "./storage";
import { knownWallet } from "./known.svelte";
import type { Block, Delegate } from "./types";

const DIRECTORY_TTL = 30 * 60_000;
const VOTERS_TTL = 30 * 60_000;

export const dir = $state({
  list: [] as Delegate[],
  loaded: false,
  complete: false,
  voters: {} as Record<string, number>,
  version: 0,
});

const byPk = new Map<string, Delegate>();
const byAddress = new Map<string, Delegate>();
const byName = new Map<string, Delegate>();

export const delegateByPk = (pk: string | undefined | null) => (pk ? byPk.get(pk) : undefined);
export const delegateByAddress = (a: string | undefined | null) => (a ? byAddress.get(a) : undefined);
export const delegateByName = (n: string) => byName.get(n.toLowerCase());
/**
 * Display name for an address: the validator's name, else a known wallet's (exchange or team).
 * Reads `dir.version` so templates re-render.
 */
export function nameOf(address: string | undefined | null): string | undefined {
  void dir.version;
  return delegateByAddress(address)?.username ?? knownWallet(address)?.name;
}

const dirKey = () => `${STORE}:delegates`;
const votersKey = () => `${STORE}:voters1`;

function index() {
  byPk.clear();
  byAddress.clear();
  byName.clear();
  for (const d of dir.list) {
    byPk.set(d.publicKey, d);
    byAddress.set(d.address, d);
    byName.set(d.username.toLowerCase(), d);
  }
  dir.version++;
}

function merge(rows: Delegate[]) {
  const map = new Map(dir.list.map((d) => [d.publicKey, d]));
  for (const r of rows) {
    const old = map.get(r.publicKey);
    // keep a locally newer last block (from live blocks) over a slightly stale API row
    if (old?.blocks.last && r.blocks.last && old.blocks.last.height > r.blocks.last.height) {
      r.blocks = old.blocks;
    }
    map.set(r.publicKey, r);
  }
  dir.list = [...map.values()].sort(
    (a, b) => Number(a.isResigned) - Number(b.isResigned) || (a.rank || 1e9) - (b.rank || 1e9) || a.username.localeCompare(b.username),
  );
  index();
}

function persist() {
  save(dirKey(), { at: Date.now(), complete: dir.complete, list: $state.snapshot(dir.list) });
}

async function loadPage(page: number, priority: "interactive" | "background"): Promise<number> {
  const body = await get(`/delegates?page=${page}&limit=100&orderBy=rank:asc`, priority);
  merge(body.data as Delegate[]);
  return body.meta?.pageCount ?? 1;
}

let fullLoad: Promise<void> | null = null;
async function loadAll() {
  const pages = await loadPage(1, "interactive");
  dir.loaded = true;
  for (let p = 2; p <= pages; p++) await loadPage(p, "background");
  dir.complete = true;
  persist();
}

/** Start the directory: cached copy first (instant), then the API. */
export function startDirectory() {
  const cached = load<{ at: number; complete: boolean; list: Delegate[] }>(dirKey());
  if (cached?.list?.length) {
    dir.list = cached.list;
    dir.loaded = true;
    dir.complete = cached.complete;
    index();
  }
  const stale = !cached || Date.now() - cached.at > DIRECTORY_TTL || !cached.complete;
  // cached voter counts show at once, even expired ones; expired ones are refetched in the background
  const v = load<{ at: number; counts: Record<string, number> }>(votersKey());
  if (v?.counts) {
    dir.voters = v.counts;
    if (Date.now() - v.at < VOTERS_TTL) {
      votersAt = v.at;
      fetched = new Set(Object.keys(v.counts));
    }
  }

  const refreshTop = () => loadPage(1, cached ? "background" : "interactive").then(() => persist()).catch(() => {});
  if (stale) fullLoad = loadAll().catch(() => {});
  else refreshTop();
  setInterval(() => {
    if (!document.hidden && !fullLoad) fullLoad = loadAll().catch(() => {}).finally(() => (fullLoad = null));
  }, DIRECTORY_TTL);

  // votes move with vote transactions: refresh the top page once per round
  let lastRound = 0;
  onNewBlocks((blocks) => {
    for (const b of blocks) {
      const d = byPk.get(b.generator.publicKey);
      if (d && (!d.blocks.last || d.blocks.last.height < b.height)) {
        d.blocks.produced++;
        d.blocks.last = { id: b.id, height: b.height, timestamp: b.timestamp };
      }
    }
    const r = roundOf(blocks[blocks.length - 1].height);
    // every visible tab (not just the polling one): one request per round keeps votes current
    if (lastRound && r !== lastRound && !document.hidden) refreshTop();
    lastRound = r;
  });
}

// ---------- voter counts ----------
let votersQueue: string[] = [];
let votersRunning = false;
let votersAt = 0;
/** counts fetched in the current TTL period; the others on screen are older and get refetched */
let fetched = new Set<string>();
/** Fetch voter counts for these delegates in the background (only ones not cached). */
const VOTER_WORKERS = 6;
const VOTER_TRIES = 3;

/**
 * Counts are collected off screen and shown together when the batch is done, so the column fills
 * (or refreshes) in one go instead of row by row. Old counts stay on screen until then.
 */
export function wantVoters(pks: string[]) {
  if (votersAt && Date.now() - votersAt > VOTERS_TTL) {
    fetched = new Set();
    votersAt = 0;
  }
  votersQueue = pks.filter((pk) => !fetched.has(pk));
  if (votersRunning || !votersQueue.length) return;
  votersRunning = true;
  const batch: Record<string, number> = {};
  const tries: Record<string, number> = {};
  const worker = async () => {
    while (votersQueue.length) {
      const pk = votersQueue.shift()!;
      if (fetched.has(pk)) continue;
      try {
        // like ArkScan: only voters holding at least 1 ARK (dust wallets would more than double the count)
        const body = await get(`/delegates/${pk}/voters?limit=1&balance.from=100000000`, "background");
        batch[pk] = body.meta?.totalCount ?? 0;
        fetched.add(pk);
      } catch {
        // retry a few times so one failed request doesn't leave a gap in the column
        if ((tries[pk] = (tries[pk] ?? 0) + 1) < VOTER_TRIES) votersQueue.push(pk);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  // a few at a time: 51 counts in a few seconds instead of ~20 s one by one
  Promise.all(Array.from({ length: VOTER_WORKERS }, worker)).finally(() => {
    votersRunning = false;
    if (!Object.keys(batch).length) return;
    if (!votersAt) votersAt = Date.now();
    dir.voters = { ...dir.voters, ...batch };
    save(votersKey(), { at: votersAt, counts: $state.snapshot(dir.voters) });
  });
}

// ---------- missed blocks ----------
interface MissedEvent {
  slot: number;
  height: number; // the height that was being forged
  pk: string;
}
interface ScanState {
  lo: number; // lowest scanned height
  loSlot: number;
  hi: number; // highest scanned height
  hiSlot: number;
  events: MissedEvent[];
}

export const missed = $state({
  /** 0..1 share of the window scanned */
  progress: 0,
  ready: false,
  windowHours: 24,
  counts: {} as Record<string, number>,
  /** latest missed slot per delegate */
  lastMissed: {} as Record<string, number>,
  total: 0,
  /** the scan reaches the tip: health dots are only shown while this holds */
  current: false,
});

const scanKey = () => `${STORE}:missed`;
let scan: ScanState | null = null;
// Like Core's detectMissedBlocks: a gap records at most activeDelegates misses, the first ones after
// the previous block (a longer gap is a network stall, not 51+ individual failures).
const MAX_GAP = 51;

const windowSlots = () => Math.round((MISSED_WINDOW_HOURS * 3600) / chain.blocktime);

async function gapEvents(a: { height: number; slot: number }, b: { height: number; slot: number }): Promise<MissedEvent[]> {
  if (b.slot - a.slot <= 1) return [];
  const order = await roundOrder(roundOf(b.height), "bulk");
  const out: MissedEvent[] = [];
  // the missing block would have had b's height, so b's round order decides who missed (Core uses the
  // round state at that height too, which is the next round right after a round's last block)
  for (let s = a.slot + 1; s < Math.min(b.slot, a.slot + 1 + MAX_GAP); s++) {
    out.push({ slot: s, height: b.height, pk: order[s % chain.activeDelegates] });
  }
  return out;
}

async function eventsIn(blocks: { height: number; slot: number }[]): Promise<MissedEvent[]> {
  const out: MissedEvent[] = [];
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].height === blocks[i - 1].height + 1) out.push(...(await gapEvents(blocks[i - 1], blocks[i])));
  }
  return out;
}

function recount() {
  if (!scan) return;
  const from = slotAt(nowMs()) - windowSlots();
  scan.events = scan.events.filter((e) => e.slot >= from);
  const counts: Record<string, number> = {};
  const last: Record<string, number> = {};
  for (const e of scan.events) {
    counts[e.pk] = (counts[e.pk] ?? 0) + 1;
    last[e.pk] = Math.max(last[e.pk] ?? 0, e.slot);
  }
  missed.counts = counts;
  missed.lastMissed = last;
  missed.total = scan.events.length;
  const span = Math.max(0, scan.hiSlot - Math.max(scan.loSlot, from));
  missed.progress = Math.min(1, span / windowSlots());
  if (scan.loSlot <= from) missed.progress = 1;
  missed.ready = missed.progress >= 1;
  missed.current = !!live.tip && live.tip.height - scan.hi <= 2;
  save(scanKey(), scan);
}

const toPoint = (b: Block) => ({ height: b.height, slot: slotOf(b.timestamp.epoch) });

async function rangeAsc(from: number, to: number, priority: "bulk" | "background" = "bulk") {
  const body = await get(`/blocks?height.from=${from}&height.to=${to}&orderBy=height:asc&limit=100`, priority);
  return (body.data as Block[]).map(toPoint);
}

let scanning = false;
// Every change to the scan runs through this queue, one at a time: live blocks, catch-up after a
// gap and the backward fill all move scan.hi / scan.lo, so they must never interleave.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => (queue = queue.then(fn).catch(() => {}));

/** Fresh scan of the latest 100 blocks (first visit, or after a gap too long to fill). */
async function freshScan(): Promise<boolean> {
  const tip = live.tip;
  if (!tip) return false;
  const pts = await rangeAsc(Math.max(1, tip.height - 99), tip.height, "background");
  if (!pts.length) return false;
  scan = { lo: pts[0].height, loSlot: pts[0].slot, hi: pts.at(-1)!.height, hiSlot: pts.at(-1)!.slot, events: await eventsIn(pts) };
  recount();
  return true;
}

/** Append blocks above scan.hi, if they continue it without a gap. */
async function extend(points: { height: number; slot: number }[]): Promise<boolean> {
  if (!scan) return false;
  const pts = points.filter((p) => p.height > scan!.hi);
  if (!pts.length) return true;
  if (pts[0].height !== scan.hi + 1) return false;
  scan.events.push(...(await eventsIn([{ height: scan.hi, slot: scan.hiSlot }, ...pts])));
  scan.hi = pts.at(-1)!.height;
  scan.hiSlot = pts.at(-1)!.slot;
  recount();
  return true;
}

/**
 * Bring the scan up to the tip. Runs on start and after ANY gap: a hidden tab or a sleeping laptop
 * reloads the recent blocks without announcing them, and a follower tab may miss messages.
 */
async function catchUp(): Promise<void> {
  for (let tries = 0; scan && live.tip && scan.hi < live.tip.height && tries < 50; ) {
    // too far behind to fill (more than the window): start over from the tip
    if (live.tip.height - scan.hi > windowSlots()) {
      if (!(await freshScan())) return;
      fillBack();
      continue;
    }
    try {
      const pts = await rangeAsc(scan.hi + 1, Math.min(scan.hi + 100, live.tip.height), "background");
      if (!pts.length || !(await extend(pts))) tries++;
    } catch {
      tries++;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Fill backward down to the start of the window (bulk priority, paused while hidden). */
let filling = false;
async function fillBack() {
  if (filling) return;
  filling = true;
  try {
    while (scan && scan.lo > 1 && scan.loSlot > slotAt(nowMs()) - windowSlots()) {
      if (document.hidden) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      try {
        const lo = scan.lo;
        const pts = await rangeAsc(Math.max(1, lo - 100), lo - 1);
        if (!pts.length) break;
        await enqueue(async () => {
          if (!scan || scan.lo !== lo) return; // the scan was restarted meanwhile
          scan.events.push(...(await eventsIn([...pts, { height: scan.lo, slot: scan.loSlot }])));
          scan.lo = pts[0].height;
          scan.loSlot = pts[0].slot;
          recount();
        });
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } finally {
    filling = false;
    recount();
  }
}

export async function startMissedScan() {
  missed.windowHours = MISSED_WINDOW_HOURS;
  const tip = live.tip;
  if (!tip || scanning) return;
  scanning = true;
  scan = load<ScanState>(scanKey());
  // stale or broken cache: start over
  if (!scan || scan.hi > tip.height || tip.height - scan.hi > windowSlots()) scan = null;
  await enqueue(async () => {
    if (!scan && !(await freshScan())) return;
    recount();
    await catchUp();
  });
  if (!scan) {
    scanning = false; // the API failed: try again shortly
    setTimeout(() => startMissedScan(), 10_000);
    return;
  }

  // live blocks extend the top; a gap (or a resync that skipped announcing blocks) is filled first
  onNewBlocks((blocks) => {
    const pts = blocks.map(toPoint);
    void enqueue(async () => {
      if (!(await extend(pts))) {
        missed.current = false;
        await catchUp();
      }
    });
  });
  // safety net: resyncs replace the recent window silently, so check for a gap regularly too
  setInterval(() => {
    recount(); // also lets old events fall out of the window
    if (scan && live.tip && live.tip.height - scan.hi > 2 && !document.hidden) void enqueue(catchUp);
  }, 30_000);

  fillBack();

  // dev only (stripped from builds): leave the scan N blocks behind, like a resync that announced
  // nothing, to test that it recovers on its own
  if (import.meta.env.DEV) {
    (window as any).__rewindMissedScan = (n: number) =>
      enqueue(async () => {
        if (!scan) return;
        scan.hi -= n;
        scan.hiSlot -= n;
        scan.events = scan.events.filter((e) => e.height <= scan!.hi);
      });
  }
}

/** Missed turns since the delegate's last forged block (its current streak), oldest first. */
function missStreak(d: Delegate): number[] {
  const lastMissed = missed.lastMissed[d.publicKey];
  if (!lastMissed || !scan) return [];
  const lastForged = d.blocks.last ? slotOf(d.blocks.last.timestamp.epoch) : 0;
  if (lastMissed < lastForged) return [];
  return scan.events.filter((e) => e.pk === d.publicKey && e.slot > lastForged).map((e) => e.slot).sort((a, b) => a - b);
}

/** Missed turns in a row, since the last forged block. */
export function missedSinceLastBlock(d: Delegate): number {
  return missStreak(d).length;
}

/** Forging health; the rule (and why) is in roundview.ts. */
export type Health = "forging" | "missed" | "not-forging" | "unknown";
/** Last health worked out while the scan was current, shown while it catches up (tab back in view). */
const lastHealth = new Map<string, Health>();
export function forgingHealth(d: Delegate): Health {
  // until the scan covers the latest blocks, "no misses seen" would just mean "not looked yet":
  // show the last known status meanwhile, and "unknown" only if there is none
  if (!missed.current) return lastHealth.get(d.publicKey) ?? "unknown";
  const h = healthFromStreak(missStreak(d), chain.activeDelegates);
  lastHealth.set(d.publicKey, h);
  return h;
}
