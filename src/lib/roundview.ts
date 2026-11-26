/**
 * Who proposes which turn of the current round, and how each turn went. Pure functions (no state,
 * no I/O) so they can be replayed against past rounds (tools/replay-rounds.mts).
 *
 * Mainsail has no time slots: a "slot" here is one proposal turn (one consensus round of one
 * block number), numbered from 0 at the round's first block number. Turn s belongs to
 * order[s % 53]. Mainsail rules (see chain.ts):
 * - a round is 53 BLOCKS; a block proposed in consensus round r used turns s…s+r of its block
 *   number, and the proposers of turns s…s+r-1 missed;
 * - so every miss pushes the rotation on by one turn: validators from the start of the order get
 *   extra turns (a down validator can get several and miss them all) until the round has its 53
 *   blocks, as on ARK Core;
 * - rarely a block is committed in a later consensus round than it was proposed in (another
 *   proposer re-proposed it). Those turns are "skipped": nobody missed them, but they still move
 *   the rotation on. They are found by matching each block's proposer to the order.
 */
export type TurnStatus =
  | { kind: "forged"; height: number; blocks: number }
  | { kind: "missed"; misses: number }
  | { kind: "skipped" }
  | { kind: "forging"; turn: number }
  | { kind: "late"; turn: number }
  | { kind: "pending"; slot: number; next: boolean; turn: number };

export interface RoundInfo {
  number: number;
  startHeight: number;
  /** first turn of the round (always 0: turns are counted from the round's first block number) */
  firstSlot: number;
  /** order[s % n] proposes turn s (the API's order, rotated to match the round's real proposers) */
  order: string[];
  /** blocks of this round by turn (publicKey holds the proposer's address) */
  forged: Record<number, { height: number; id: string; publicKey: string }>;
  /** turns no one missed but that the rotation passed (re-proposals) */
  skipped: Record<number, true>;
  count: number;
  /** turn of the latest block (-1 before the first one) */
  tipSlot: number;
  /** first turn of the next block number */
  nextSlot: number;
}

export interface RoundBlock {
  height: number;
  id: string;
  /** proposer address */
  proposer: string;
  /** consensus round the block was proposed in */
  round: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Round `number` from its validators in the API's order and its blocks so far. */
export function buildRound(number: number, startHeight: number, list: string[], blocks: RoundBlock[]): RoundInfo {
  const r: RoundInfo = { number, startHeight, firstSlot: 0, order: [...list], forged: {}, skipped: {}, count: 0, tipSlot: -1, nextSlot: 0 };
  const mine = blocks.filter((b) => b.height >= startHeight).sort((a, b) => a.height - b.height);
  for (const b of mine) addBlock(r, b);
  return r;
}

/** Add the round's next block (in height order). */
export function addBlock(r: RoundInfo, b: RoundBlock) {
  const n = r.order.length;
  const p = b.proposer.toLowerCase();
  if (r.count === 0) {
    // the round's first block was proposed on turn b.round: rotate the order to match
    const i = r.order.findIndex((a) => a.toLowerCase() === p);
    if (i >= 0) {
      const base = mod(i - b.round, n);
      r.order = Array.from({ length: n }, (_, k) => r.order[(base + k) % n]);
    }
  }
  let s = r.nextSlot;
  // the proposer's turn at or after the expected one; a later one means re-proposal turns between
  for (let extra = 0; extra < n; extra++) {
    if (r.order[(r.nextSlot + extra + b.round) % n].toLowerCase() === p) {
      s = r.nextSlot + extra;
      break;
    }
  }
  for (let k = r.nextSlot; k < s; k++) r.skipped[k] = true;
  const at = s + b.round;
  r.forged[at] = { height: b.height, id: b.id, publicKey: b.proposer };
  r.count++;
  r.tipSlot = at;
  r.nextSlot = at + 1;
}

/** A copy that addBlock can change without touching the original. */
export function cloneRound(r: RoundInfo): RoundInfo {
  return { ...r, order: [...r.order], forged: { ...r.forged }, skipped: { ...r.skipped } };
}

/**
 * Consensus round of the round's next block when only its proposer is known (JSON-RPC blocks do
 * not carry it): the proposer's first turn from the next one on, so every turn before it counts
 * as missed. Right unless the block was re-proposed (rare); the REST block replaces it anyway.
 * Before the round's first block the order's rotation is not anchored yet, so 0 is assumed.
 */
export function inferRound(r: RoundInfo, proposer: string): number {
  if (r.count === 0) return 0;
  const n = r.order.length;
  const p = proposer.toLowerCase();
  for (let k = 0; k < n; k++) if (r.order[(r.nextSlot + k) % n].toLowerCase() === p) return k;
  return 0;
}

/**
 * Last turn that certainly belongs to the round: it still needs `n - count` blocks, so even if
 * every turn after the tip produces one it lasts until tipSlot + (n - count). -1 once complete.
 */
export function roundEndSlot(r: RoundInfo, tipSlot: number, n: number): number {
  return r.count < n ? Math.max(tipSlot, r.firstSlot - 1) + (n - r.count) : -1;
}

function turnStatus(r: RoundInfo, s: number, tipSlot: number, curSlot: number, turn: number): TurnStatus {
  const f = r.forged[s];
  if (f) return { kind: "forged", height: f.height, blocks: 1 };
  if (r.skipped[s]) return { kind: "skipped" };
  if (s < tipSlot) return { kind: "missed", misses: 1 }; // a later block exists: the turn passed without one
  if (s === curSlot) return { kind: "forging", turn };
  if (s < curSlot) return { kind: "late", turn };
  return { kind: "pending", slot: s, next: s === curSlot + 1, turn };
}

/**
 * Forging View: one row per turn of the round. It starts with 53 rows; every missed turn adds one
 * at the end, for the validator whose extra turn that is. Ends at the round's last block (when
 * complete) or at roundEndSlot.
 */
export function roundSlots(r: RoundInfo, tipSlot: number, curSlot: number, n: number) {
  const end = r.count >= n ? Math.max(...Object.keys(r.forged).map(Number)) : roundEndSlot(r, tipSlot, n);
  const out: { slot: number; pk: string; turn: number; st: TurnStatus }[] = [];
  for (let s = r.firstSlot; s <= end; s++) {
    const turn = Math.floor((s - r.firstSlot) / n) + 1;
    out.push({ slot: s, pk: r.order[s % n], turn, st: turnStatus(r, s, tipSlot, curSlot, turn) });
  }
  return out;
}

/**
 * Rank View: one status per validator over all its turns this round. Precedence: forging now > late >
 * next turn coming > forged (with the block count) > missed (with the miss count).
 */
export function validatorStatus(r: RoundInfo, tipSlot: number, curSlot: number, n: number): Map<string, TurnStatus> {
  const out = new Map<string, TurnStatus>();
  const forged = new Map<string, { height: number; blocks: number }>();
  const misses = new Map<string, number>();
  const first = new Map<string, TurnStatus>();
  for (const { pk, st } of roundSlots(r, tipSlot, curSlot, n)) {
    if (st.kind === "forged") {
      const f = forged.get(pk);
      forged.set(pk, { height: st.height, blocks: (f?.blocks ?? 0) + 1 });
    } else if (st.kind === "missed") misses.set(pk, (misses.get(pk) ?? 0) + 1);
    else if (st.kind !== "skipped" && !first.has(pk)) first.set(pk, st); // forging / late / the next pending turn
  }
  for (let p = 0; p < n; p++) {
    const pk = r.order[(r.firstSlot + p) % n];
    const f = forged.get(pk);
    const m = misses.get(pk);
    out.set(
      pk,
      first.get(pk) ?? (f ? { kind: "forged", height: f.height, blocks: f.blocks } : { kind: "missed", misses: m ?? 0 }),
    );
  }
  return out;
}

/** Proposer of turn `slot`, if it certainly belongs to the round (otherwise the next round's order decides). */
export function forgerOf(r: RoundInfo, slot: number, tipSlot: number, n: number): string | undefined {
  return slot <= roundEndSlot(r, tipSlot, n) ? r.order[slot % n] : undefined;
}

/**
 * Validators that missed while block `b` was being decided: the proposers of consensus rounds
 * 0…b.round-1 of its block number. `list` is the round's order in ANY rotation (the block's own
 * proposer anchors it), so a stored order that starts elsewhere still gives the right names.
 */
export function missedBefore(list: string[], b: RoundBlock): string[] {
  if (!b.round) return [];
  const n = list.length;
  const i = list.findIndex((a) => a.toLowerCase() === b.proposer.toLowerCase());
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = 0; k < b.round && k < n; k++) out.push(list[mod(i - b.round + k, n)]);
  return out;
}

/**
 * Forging health from the positions (proposal turns) of a validator's current streak of missed
 * turns (since its last block), ascending:
 * - forging: produced a block on its last turn;
 * - missed: missed its last turn (a restart or a network hiccup costs one turn);
 * - dead ("not-forging"): 2 turns in a row at least half a rotation apart, or 3+.
 * Turns are normally a rotation (53 turns) apart, but at a round change the new order can put two
 * turns of one validator back to back: two misses that close prove little, so they stay "missed"
 * until the span (or a third miss) shows real downtime.
 */
export function healthFromStreak(streak: number[], n: number): "forging" | "missed" | "not-forging" {
  if (streak.length === 0) return "forging";
  if (streak.length >= 3) return "not-forging";
  if (streak.length === 2 && streak[1] - streak[0] >= Math.ceil(n / 2)) return "not-forging";
  return "missed";
}
