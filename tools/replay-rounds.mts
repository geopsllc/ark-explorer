// Replays rounds slot by slot through src/lib/roundview.ts and checks it against what happened.
// usage: npm run test:rounds   (needs network: reads past rounds from api.ark.io)
import { createHash } from "node:crypto";
const rv = await import(new URL("../src/lib/roundview.ts", import.meta.url).href);
const N = 51;
const API = "https://api.ark.io/api";
const slotOf = (epoch: number) => Math.floor(epoch / 8);
let failures = 0;
const fail = (msg: string) => {
  failures++;
  if (failures < 30) console.log("FAIL", msg);
};

function shuffle(pks: string[], round: number) {
  const d = [...pks];
  let seed = createHash("sha256").update(String(round)).digest();
  for (let i = 0, n = d.length; i < n; i++) {
    for (let x = 0; x < 4 && i < n; i++, x++) {
      const k = seed[x] % n;
      [d[k], d[i]] = [d[i], d[k]];
    }
    seed = createHash("sha256").update(seed).digest();
  }
  return d;
}
const j = async (p: string) => (await fetch(API + p)).json();

/** Replay one round: blocks = [{slot, height, pk}] of the round in order, F = first slot. */
function replay(label: string, order: string[], F: number, blocks: { slot: number; height: number; pk: string }[], startHeight: number) {
  const bySlot = new Map(blocks.map((b) => [b.slot, b]));
  const lastSlot = blocks[blocks.length - 1].slot;
  for (let cur = F; cur <= lastSlot + 3; cur++) {
    // perfect propagation: at slot `cur` every block of an earlier slot is visible
    const seen = blocks.filter((b) => b.slot < cur);
    const r = { number: 0, startHeight, firstSlot: F, order, forged: {} as Record<number, any>, count: seen.length };
    for (const b of seen) r.forged[b.slot] = { height: b.height, id: "", publicKey: b.pk };
    const tipSlot = seen.length ? seen[seen.length - 1].slot : F - 1;
    const missesSoFar = Array.from({ length: Math.max(0, tipSlot - F + 1) }, (_, i) => F + i).filter((s) => !bySlot.has(s)).length;

    const rows = rv.roundSlots(r, tipSlot, cur, N);
    // rows: 51 + one per miss so far, while the round runs; exact span once complete
    const want = seen.length >= N ? lastSlot - F + 1 : N + missesSoFar;
    if (rows.length !== want) fail(`${label} cur=${cur - F}: ${rows.length} rows, want ${want}`);
    for (const row of rows) {
      const b = bySlot.get(row.slot);
      if (b && b.pk !== row.pk) fail(`${label} slot ${row.slot - F}: row says ${row.pk.slice(0, 8)}, forged by ${b.pk.slice(0, 8)}`);
      if (b && b.slot < cur && row.st.kind !== "forged") fail(`${label} slot ${row.slot - F}: ${row.st.kind}, was forged`);
      if (!b && row.slot < tipSlot && row.st.kind !== "missed") fail(`${label} slot ${row.slot - F}: ${row.st.kind}, was missed`);
    }
    // every block of the round has a row once forged
    for (const b of seen) if (!rows.some((x: any) => x.slot === b.slot)) fail(`${label}: block at slot ${b.slot - F} has no row`);
    // forger shown for the current slot must be the one who forges it (when it is this round's)
    const fNow = rv.forgerOf(r, cur, tipSlot, N);
    const bNow = bySlot.get(cur);
    if (fNow && bNow && fNow !== bNow.pk) fail(`${label} cur=${cur - F}: forging now ${fNow.slice(0, 8)}, actually ${bNow.pk.slice(0, 8)}`);
    if (fNow && cur > lastSlot) fail(`${label} cur=${cur - F}: claims a forger for a slot of the next round`);
    // validator status: counts add up
    const vs = rv.validatorStatus(r, tipSlot, cur, N);
    if (vs.size !== N) fail(`${label}: ${vs.size} validator statuses`);
    let fb = 0;
    for (const st of vs.values()) if (st.kind === "forged") fb += st.blocks;
    const pendingOrNow = [...vs.values()].filter((s: any) => s.kind !== "forged" && s.kind !== "missed").length;
    if (seen.length >= N && pendingOrNow) fail(`${label}: complete round still has ${pendingOrNow} open turns`);
  }
  // final state: per-validator block and miss counts equal the truth
  const r = { number: 0, startHeight, firstSlot: F, order, forged: {} as Record<number, any>, count: blocks.length };
  for (const b of blocks) r.forged[b.slot] = { height: b.height, id: "", publicKey: b.pk };
  const vs = rv.validatorStatus(r, lastSlot, lastSlot + 1, N);
  for (const pk of new Set(order)) {
    const forged = blocks.filter((b) => b.pk === pk).length;
    const misses = Array.from({ length: lastSlot - F + 1 }, (_, i) => F + i).filter((s) => order[s % N] === pk && !bySlot.has(s)).length;
    const st = vs.get(pk);
    if (forged && (st.kind !== "forged" || st.blocks !== forged)) fail(`${label} final ${pk.slice(0, 8)}: ${JSON.stringify(st)}, forged ${forged}`);
    if (!forged && (st.kind !== "missed" || st.misses !== misses)) fail(`${label} final ${pk.slice(0, 8)}: ${JSON.stringify(st)}, missed ${misses}`);
  }
  const extra = blocks.filter((b) => b.slot >= F + N).length;
  console.log(`ok  ${label}: ${lastSlot - F + 1} slots, ${lastSlot - F + 1 - N} missed, ${extra} extra-turn blocks`);
}

// ---- real mainnet rounds (with and without misses) ----
for (const R of [740618, 740619, 742305, 741874, 742700]) {
  const st = (R - 1) * N + 1;
  const all = (await j(`/blocks?height.from=${st - 1}&height.to=${st + 50}&orderBy=height:asc&limit=100`)).data;
  const dl = (await j(`/rounds/${R}/delegates`)).data as { publicKey: string; votes: string }[];
  dl.sort((a, b) => (BigInt(b.votes) > BigInt(a.votes) ? 1 : BigInt(b.votes) < BigInt(a.votes) ? -1 : a.publicKey < b.publicKey ? -1 : 1));
  const order = shuffle(dl.map((d) => d.publicKey), R);
  const F = slotOf(all[0].timestamp.epoch) + 1;
  const blocks = all.slice(1).map((b: any) => ({ slot: slotOf(b.timestamp.epoch), height: b.height, pk: b.generator.publicKey }));
  replay(`mainnet round ${R}`, order, F, blocks, st);
}

// ---- synthetic rounds: k validators down, Core's rule decides who forges ----
function synth(down: Set<number>, F: number, label: string) {
  const order = Array.from({ length: N }, (_, i) => `pk${String(i).padStart(2, "0")}`.padEnd(66, "0"));
  const blocks: { slot: number; height: number; pk: string }[] = [];
  for (let s = F; blocks.length < N; s++) if (!down.has(s % N)) blocks.push({ slot: s, height: 1000 + blocks.length, pk: order[s % N] });
  replay(label, order, F, blocks, 1000);
}
const F0 = 51 * 1000 + 7; // first slot not at index 0: the rotation starts mid-order
synth(new Set([F0 % N]), F0, "synthetic: first validator of the round down (gets an extra turn, misses it too)");
synth(new Set([(F0 + 3) % N, (F0 + 4) % N, (F0 + 5) % N]), F0, "synthetic: 3 validators down in a row");
synth(new Set(Array.from({ length: 20 }, (_, i) => (F0 + i * 2) % N)), F0, "synthetic: 20 validators down");
synth(new Set(Array.from({ length: 40 }, (_, i) => (F0 + i) % N)), F0, "synthetic: 40 down, 11 up (several turns each)");

// ---- dead rule ----
const h = (streak: number[]) => rv.healthFromStreak(streak, N);
const cases: [number[], string][] = [
  [[], "forging"],
  [[100], "missed"],
  [[100, 101], "missed"], // back-to-back turns at a round change: 8 s of evidence
  [[100, 125], "missed"],
  [[100, 126], "not-forging"],
  [[100, 143], "not-forging"], // mainnet 740618/740619 case: 43 slots apart
  [[100, 151], "not-forging"], // second (extra) turn in the same round
  [[100, 101, 102], "not-forging"],
];
for (const [s, want] of cases) if (h(s) !== want) fail(`health ${JSON.stringify(s)} = ${h(s)}, want ${want}`);
console.log(`ok  dead rule: ${cases.length} cases`);
console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
