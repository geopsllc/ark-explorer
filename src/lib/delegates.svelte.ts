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
  const v = load<{ at: number; counts: Record<string, number> }>(votersKey());
  if (v && Date.now() - v.at < VOTERS_TTL) dir.voters = v.counts;

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
    if (lastRound && r !== lastRound && live.leader) refreshTop();
    lastRound = r;
  });
}

// ---------- voter counts ----------
let votersQueue: string[] = [];
let votersRunning = false;
let votersAt = 0;
/** Fetch voter counts for these delegates in the background (only ones not cached). */
const VOTER_WORKERS = 6;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Persist the counts at most every 500 ms while they stream in. */
function saveVoters() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save(votersKey(), { at: votersAt, counts: $state.snapshot(dir.voters) });
  }, 500);
}

export function wantVoters(pks: string[]) {
  if (Date.now() - votersAt > VOTERS_TTL && votersAt) {
    dir.voters = {};
    votersAt = 0;
  }
  votersQueue = pks.filter((pk) => dir.voters[pk] === undefined);
  if (votersRunning) return;
  votersRunning = true;
  const worker = async () => {
    while (votersQueue.length) {
      const pk = votersQueue.shift()!;
      if (dir.voters[pk] !== undefined) continue;
      try {
        // like ArkScan: only voters holding at least 1 ARK (dust wallets would more than double the count)
        const body = await get(`/delegates/${pk}/voters?limit=1&balance.from=100000000`, "background");
        dir.voters[pk] = body.meta?.totalCount ?? 0;
        if (!votersAt) votersAt = Date.now();
        saveVoters();
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  // a few at a time: 51 counts in a few seconds instead of ~20 s one by one
  Promise.all(Array.from({ length: VOTER_WORKERS }, worker)).finally(() => (votersRunning = false));
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
});

const scanKey = () => `${STORE}:missed`;
let scan: ScanState | null = null;
const MAX_GAP = 51; // a longer gap is a network stall; record one round of misses at most

const windowSlots = () => Math.round((MISSED_WINDOW_HOURS * 3600) / chain.blocktime);

async function gapEvents(a: { height: number; slot: number }, b: { height: number; slot: number }): Promise<MissedEvent[]> {
  if (b.slot - a.slot <= 1) return [];
  const order = await roundOrder(roundOf(b.height), "bulk");
  const out: MissedEvent[] = [];
  for (let s = Math.max(a.slot + 1, b.slot - MAX_GAP); s < b.slot; s++) {
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
  save(scanKey(), scan);
}

const toPoint = (b: Block) => ({ height: b.height, slot: slotOf(b.timestamp.epoch) });

async function rangeAsc(from: number, to: number) {
  const body = await get(`/blocks?height.from=${from}&height.to=${to}&orderBy=height:asc&limit=100`, "bulk");
  return (body.data as Block[]).map(toPoint);
}

let scanning = false;
export async function startMissedScan() {
  missed.windowHours = MISSED_WINDOW_HOURS;
  const tip = live.tip;
  if (!tip || scanning) return;
  scanning = true;
  scan = load<ScanState>(scanKey());
  // stale or broken cache: start over
  if (!scan || scan.hi > tip.height || tip.height - scan.hi > windowSlots() * 2) scan = null;
  if (!scan) {
    const pts = await rangeAsc(Math.max(1, tip.height - 99), tip.height).catch(() => []);
    if (!pts.length) {
      scanning = false;
      return;
    }
    scan = { lo: pts[0].height, loSlot: pts[0].slot, hi: pts.at(-1)!.height, hiSlot: pts.at(-1)!.slot, events: await eventsIn(pts) };
  }
  recount();

  // live blocks extend the top
  onNewBlocks(async (blocks) => {
    if (!scan) return;
    const pts = blocks.map(toPoint).filter((p) => p.height > scan!.hi);
    if (!pts.length || pts[0].height !== scan.hi + 1) return; // gap: the forward scan below fills it
    const ev = await eventsIn([{ height: scan.hi, slot: scan.hiSlot }, ...pts]);
    scan.events.push(...ev);
    scan.hi = pts.at(-1)!.height;
    scan.hiSlot = pts.at(-1)!.slot;
    recount();
  });

  // forward: from the cached top up to the tip
  while (live.tip && scan.hi < live.tip.height - 1) {
    try {
      const pts = await rangeAsc(scan.hi + 1, Math.min(scan.hi + 100, live.tip.height));
      if (!pts.length || pts[0].height !== scan.hi + 1) break;
      scan.events.push(...(await eventsIn([{ height: scan.hi, slot: scan.hiSlot }, ...pts])));
      scan.hi = pts.at(-1)!.height;
      scan.hiSlot = pts.at(-1)!.slot;
      recount();
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // backward: down to the start of the window
  while (scan.lo > 1 && scan.loSlot > slotAt(nowMs()) - windowSlots()) {
    if (document.hidden) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    try {
      const from = Math.max(1, scan.lo - 100);
      const pts = await rangeAsc(from, scan.lo - 1);
      if (!pts.length) break;
      scan.events.push(...(await eventsIn([...pts, { height: scan.lo, slot: scan.loSlot }])));
      scan.lo = pts[0].height;
      scan.loSlot = pts[0].slot;
      recount();
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  recount();
  setInterval(recount, 60_000); // let old events fall out of the window
}

/** Forging status from missed-slot history: 0 = forging, 1 = missed last slot, 2+ = not forging. */
export function missedSinceLastBlock(d: Delegate): number {
  const lastMissed = missed.lastMissed[d.publicKey];
  if (!lastMissed || !scan) return 0;
  const lastForged = d.blocks.last ? slotOf(d.blocks.last.timestamp.epoch) : 0;
  if (lastMissed < lastForged) return 0;
  return scan.events.filter((e) => e.pk === d.publicKey && e.slot > lastForged).length;
}
