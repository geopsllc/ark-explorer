/**
 * Who forges which slot of the current round, and how each turn went. Pure functions (no state,
 * no I/O) so they can be replayed against past rounds.
 *
 * ARK Core rules (core-kernel calculate-forging-info + round-calculator, core-state round-state):
 * - a round is 51 BLOCKS (by height), not 51 slots;
 * - a slot's forger is order[slot % 51], order being the round of the block that slot would make;
 * - so every missed slot stretches the round by one slot and the rotation wraps: validators from the
 *   start of the order get extra turns (a down validator can get several and miss them all) until
 *   the round has its 51 blocks. The next round starts at the slot after its last block.
 */
import type { RoundInfo } from "./live.svelte";

export type TurnStatus =
  | { kind: "forged"; height: number; blocks: number }
  | { kind: "missed"; misses: number }
  | { kind: "forging"; turn: number }
  | { kind: "late"; turn: number }
  | { kind: "pending"; slot: number; next: boolean; turn: number };

/**
 * Last slot that certainly belongs to the round: it still needs `n - count` blocks, so even if every
 * slot after the tip is forged it lasts until tipSlot + (n - count). -1 once it is complete (later
 * slots belong to the next round, whose order isn't known until this one ends).
 */
export function roundEndSlot(r: RoundInfo, tipSlot: number, n: number): number {
  return r.count < n ? Math.max(tipSlot, r.firstSlot - 1) + (n - r.count) : -1;
}

function turnStatus(r: RoundInfo, s: number, tipSlot: number, curSlot: number, turn: number): TurnStatus {
  const f = r.forged[s];
  if (f) return { kind: "forged", height: f.height, blocks: 1 };
  if (s < tipSlot) return { kind: "missed", misses: 1 }; // a later block exists: the slot passed empty
  if (s === curSlot) return { kind: "forging", turn };
  if (s < curSlot) return { kind: "late", turn };
  return { kind: "pending", slot: s, next: s === curSlot + 1, turn };
}

/**
 * Forging View: one row per slot of the round. It starts with 51 rows; every missed slot adds one at
 * the end, for the validator whose extra turn that slot is. Ends at the round's last block (when
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
  let forged = new Map<string, { height: number; blocks: number }>();
  let misses = new Map<string, number>();
  const first = new Map<string, TurnStatus>();
  for (const { pk, st } of roundSlots(r, tipSlot, curSlot, n)) {
    if (st.kind === "forged") {
      const f = forged.get(pk);
      forged.set(pk, { height: st.height, blocks: (f?.blocks ?? 0) + 1 });
    } else if (st.kind === "missed") misses.set(pk, (misses.get(pk) ?? 0) + 1);
    else if (!first.has(pk)) first.set(pk, st); // forging / late / the next pending turn
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

/** Forger of `slot`, if it certainly belongs to the round (otherwise the next round's order decides). */
export function forgerOf(r: RoundInfo, slot: number, tipSlot: number, n: number): string | undefined {
  return slot <= roundEndSlot(r, tipSlot, n) ? r.order[slot % n] : undefined;
}

/**
 * Forging health from the slots of a validator's current streak of missed turns (since its last
 * block), ascending:
 * - forging: forged on its last turn;
 * - missed: missed its last turn (a restart or a network hiccup costs one slot);
 * - dead ("not-forging"): 2 turns in a row spanning at least half a rotation (~3.5 min), or 3+.
 * Turns are normally ~51 slots apart (extra turns in a long round too), but at a round change the
 * reshuffled order can put two turns of one validator back to back, 8 s apart: two misses that close
 * prove little, so they stay "missed" until the span (or a third miss) shows real downtime.
 */
export function healthFromStreak(streak: number[], n: number): "forging" | "missed" | "not-forging" {
  if (streak.length === 0) return "forging";
  if (streak.length >= 3) return "not-forging";
  if (streak.length === 2 && streak[1] - streak[0] >= Math.ceil(n / 2)) return "not-forging";
  return "missed";
}
