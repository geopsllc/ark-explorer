/**
 * Validator directory, voter counts and missed-block tracking.
 *
 * Request plan (the public API allows 200 requests/min per IP):
 * - Directory: /validators, 2 pages of 100 (the testnet has ~100 validators). Page 1 is loaded
 *   first and refreshed once per round; the rest loads in the background and refreshes every
 *   30 min. Produced blocks and last block are updated locally from live blocks, so they are exact
 *   between refreshes. Voter counts come with the directory (Mainsail keeps them per validator).
 * - Missed blocks: every block says which consensus round it was proposed in, and round r > 0
 *   means the proposers of rounds 0…r-1 missed; the round's proposal order says who they were
 *   (roundview.ts missedBefore). The last MISSED_WINDOW_HOURS (24) are scanned once, 100 blocks
 *   per request (plus one /rounds page per 100 rounds), then kept current from live blocks and
 *   cached, so a returning visitor only scans what is new.
 *
 * Validators are keyed by address (lower case): blocks name their proposer by address and votes
 * name the validator's address. `Delegate.publicKey` holds the address too (see ms.ts).
 */
import { get } from "./api";
import { MISSED_WINDOW_HOURS, STORE } from "./site";
import { chain, roundOf, roundOrder } from "./chain";
import { healthFromStreak, missedBefore } from "./roundview";
import { live, nowMs, onNewBlocks } from "./live.svelte";
import { load, save } from "./storage";
import { knownWallet } from "./known.svelte";
import { mapBlock, mapValidator } from "./ms";
import type { Block, Delegate } from "./types";

const DIRECTORY_TTL = 30 * 60_000;

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

/** By address (the key validators have on Mainsail; any letter case). */
export const delegateByPk = (pk: string | undefined | null) => (pk ? byPk.get(pk.toLowerCase()) : undefined);
export const delegateByAddress = (a: string | undefined | null) => (a ? byAddress.get(a.toLowerCase()) : undefined);
export const delegateByName = (n: string) => byName.get(n.toLowerCase());
/**
 * Display name for an address: the validator's name, else a known wallet's (exchange or team).
 * Reads `dir.version` so templates re-render.
 */
export function nameOf(address: string | undefined | null): string | undefined {
  void dir.version;
  return delegateByAddress(address)?.username ?? knownWallet(address)?.name;
}

const dirKey = () => `${STORE}:validators`;

function index() {
  byPk.clear();
  byAddress.clear();
  byName.clear();
  const voters: Record<string, number> = {};
  for (const d of dir.list) {
    byPk.set(d.publicKey.toLowerCase(), d);
    byAddress.set(d.address.toLowerCase(), d);
    byName.set(d.username.toLowerCase(), d);
    if (typeof d.voters === "number") voters[d.publicKey] = d.voters;
  }
  dir.voters = voters;
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
  const body = await get(`/validators?page=${page}&limit=100`, priority);
  merge((body.data as any[]).map(mapValidator));
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
      const d = byPk.get(b.generator.address.toLowerCase());
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

// ---------- missed blocks ----------
interface MissedEvent {
  /** time of the block whose number was being decided (ms) */
  ms: number;
  height: number;
  /** consensus round that was missed */
  k: number;
  /** validator address, lower case */
  pk: string;
}
/** A scanned block: just what the scan needs. */
interface Point {
  height: number;
  ms: number;
  round: number;
  proposer: string;
}
interface ScanState {
  lo: number; // lowest scanned height
  loMs: number;
  hi: number; // highest scanned height
  hiMs: number;
  events: MissedEvent[];
}

export const missed = $state({
  /** 0..1 share of the window scanned */
  progress: 0,
  ready: false,
  windowHours: 24,
  /** by validator address, lower case */
  counts: {} as Record<string, number>,
  /** latest missed turn per validator (ms) */
  lastMissed: {} as Record<string, number>,
  total: 0,
  /** the scan reaches the tip: health dots are only shown while this holds */
  current: false,
});

const scanKey = () => `${STORE}:missed`;
let scan: ScanState | null = null;

const windowMs = () => MISSED_WINDOW_HOURS * 3600_000;
/** the newest round there is (so a missing round order is fetched with its whole /rounds page) */
const latestRound = () => (live.tip ? roundOf(live.tip.height) : 0);

async function eventsIn(points: Point[]): Promise<MissedEvent[]> {
  const out: MissedEvent[] = [];
  for (const p of points) {
    if (!p.round) continue;
    const list = await roundOrder(roundOf(p.height), "bulk", latestRound());
    missedBefore(list, { height: p.height, id: "", proposer: p.proposer, round: p.round }).forEach((a, k) =>
      out.push({ ms: p.ms, height: p.height, k, pk: a.toLowerCase() }),
    );
  }
  return out;
}

function recount() {
  if (!scan) return;
  const from = nowMs() - windowMs();
  scan.events = scan.events.filter((e) => e.ms >= from);
  const counts: Record<string, number> = {};
  const last: Record<string, number> = {};
  for (const e of scan.events) {
    counts[e.pk] = (counts[e.pk] ?? 0) + 1;
    last[e.pk] = Math.max(last[e.pk] ?? 0, e.ms);
  }
  missed.counts = counts;
  missed.lastMissed = last;
  missed.total = scan.events.length;
  // share of the window's blocks scanned (a stalled chain has none after its tip)
  const span = Math.max(0, scan.hiMs - Math.max(scan.loMs, from));
  missed.progress = Math.min(1, span / Math.max(1, scan.hiMs - from));
  if (scan.loMs <= from || scan.lo <= chain.genesis + 1) missed.progress = 1;
  missed.ready = missed.progress >= 1;
  missed.current = !!live.tip && live.tip.height - scan.hi <= 2;
  save(scanKey(), scan);
}

const toPoint = (b: Block): Point => ({ height: b.height, ms: b.timestamp.unix * 1000, round: b.round, proposer: b.generator.address });

async function rangeAsc(from: number, to: number, priority: "bulk" | "background" = "bulk") {
  const body = await get(`/blocks?number.from=${from}&number.to=${to}&orderBy=number:asc&limit=100`, priority);
  return (body.data as any[]).map(mapBlock).map(toPoint);
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
  const pts = await rangeAsc(Math.max(chain.genesis + 1, tip.height - 99), tip.height, "background");
  if (!pts.length) return false;
  scan = { lo: pts[0].height, loMs: pts[0].ms, hi: pts.at(-1)!.height, hiMs: pts.at(-1)!.ms, events: await eventsIn(pts) };
  recount();
  return true;
}

/** Append blocks above scan.hi, if they continue it without a gap. */
async function extend(points: Point[]): Promise<boolean> {
  if (!scan) return false;
  const pts = points.filter((p) => p.height > scan!.hi);
  if (!pts.length) return true;
  if (pts[0].height !== scan.hi + 1) return false;
  scan.events.push(...(await eventsIn(pts)));
  scan.hi = pts.at(-1)!.height;
  scan.hiMs = pts.at(-1)!.ms;
  recount();
  return true;
}

/** Blocks in a full window at most (8 s each), to tell when filling a gap is not worth it. */
const windowBlocks = () => Math.round(windowMs() / 1000 / chain.blocktime);

/**
 * Bring the scan up to the tip. Runs on start and after ANY gap: a hidden tab or a sleeping laptop
 * reloads the recent blocks without announcing them, and a follower tab may miss messages.
 */
async function catchUp(): Promise<void> {
  for (let tries = 0; scan && live.tip && scan.hi < live.tip.height && tries < 50; ) {
    // too far behind to fill (more than the window): start over from the tip
    if (live.tip.height - scan.hi > windowBlocks()) {
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
    while (scan && scan.lo > chain.genesis + 1 && scan.loMs > nowMs() - windowMs()) {
      if (document.hidden) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      try {
        const lo = scan.lo;
        const pts = await rangeAsc(Math.max(chain.genesis + 1, lo - 100), lo - 1);
        if (!pts.length) break;
        await enqueue(async () => {
          if (!scan || scan.lo !== lo) return; // the scan was restarted meanwhile
          scan.events.push(...(await eventsIn(pts)));
          scan.lo = pts[0].height;
          scan.loMs = pts[0].ms;
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
  if (!scan || typeof scan.hiMs !== "number" || scan.hi > tip.height || tip.height - scan.hi > windowBlocks()) scan = null;
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
        scan.events = scan.events.filter((e) => e.height <= scan!.hi);
      });
  }
}

/** Missed turns since the validator's last block (its current streak), oldest first, in ms. */
function missStreak(d: Delegate): number[] {
  const pk = d.publicKey.toLowerCase();
  const lastMissed = missed.lastMissed[pk];
  if (!lastMissed || !scan) return [];
  const lastHeight = d.blocks.last?.height ?? 0;
  return scan.events.filter((e) => e.pk === pk && e.height > lastHeight).map((e) => e.ms + e.k).sort((a, b) => a - b);
}

/** Missed turns in a row, since the last block. */
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
  // streak positions in 8 s turns: half a rotation is ~27 turns (~3.5 min)
  const h = healthFromStreak(missStreak(d).map((ms) => ms / (chain.blocktime * 1000)), chain.activeDelegates);
  lastHealth.set(d.publicKey, h);
  return h;
}

/** Missed turns in the window, by address. */
export const missedCount = (address: string | undefined | null) => (address ? (missed.counts[address.toLowerCase()] ?? 0) : 0);
