/**
 * Replays recent Mainsail testnet rounds through the round logic (src/lib/roundview.ts) and checks
 * it against what the chain recorded:
 *  - every block lands on a turn whose proposer (by the calibrated order) is the block's proposer;
 *  - the Forging View's missed turns are exactly the misses the blocks record (sum of block.round),
 *    by the same validators that missedBefore() names (which the missed-block scan uses);
 *  - a complete round has 53 blocks and 53 + misses + skipped rows;
 *  - a block known only by its proposer (JSON-RPC, before REST has it) gets its consensus round
 *    right from the order (inferRound), except right after a re-proposal.
 * Plus synthetic rounds for the edge cases (misses at the start, extra turns, a re-proposal).
 *
 *   npm run test:rounds [rounds=20]
 */
import { addBlock, buildRound, inferRound, missedBefore, roundSlots, validatorStatus, type RoundBlock } from "../src/lib/roundview.ts";

const API = "https://testnet.mainsailhq.com/api";
const N = 53;
const get = async (p: string) => {
  const r = await fetch(API + p, { headers: { "User-Agent": "curl/8.7.1" } });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failures++;
    console.log("  FAIL " + msg);
  }
};

// ---------- synthetic ----------
{
  const list = Array.from({ length: N }, (_, i) => `v${i}`);
  // the stored order starts 5 places off; v1…v10 are down (so the round runs long enough for them to
  // get extra turns and miss those too), v12 misses its first turn only, one re-proposal at height 30
  const stored = [...list.slice(5), ...list.slice(0, 5)];
  const blocks: RoundBlock[] = [];
  let turn = 0;
  for (let h = 0; blocks.length < N; h++) {
    let r = 0;
    const down = (v: string, t: number) => /^v([1-9]|10)$/.test(v) || (v === "v12" && t < N);
    while (down(list[(turn + r) % N], turn + r)) r++;
    blocks.push({ height: 1000 + h, id: `b${h}`, proposer: list[(turn + r) % N], round: r });
    turn += r + 1 + (h === 30 ? 1 : 0); // height 30 committed one consensus round later
  }
  const round = buildRound(1, 1000, stored, blocks);
  const rows = roundSlots(round, round.tipSlot, round.tipSlot + 1, N);
  const misses = rows.filter((x) => x.st.kind === "missed");
  const skipped = rows.filter((x) => x.st.kind === "skipped");
  const expected = blocks.reduce((s, b) => s + b.round, 0);
  console.log(`synthetic: ${rows.length} rows, ${misses.length} missed, ${skipped.length} skipped`);
  check(misses.length === expected, `synthetic misses ${misses.length} != ${expected}`);
  check(skipped.length === 1, `synthetic skipped ${skipped.length} != 1`);
  check(misses.every((m) => /^v([1-9]|1[02])$/.test(m.pk)), "synthetic: someone else missed");
  check(rows.length === N + expected + 1, `synthetic rows ${rows.length}`);
  const st = validatorStatus(round, round.tipSlot, round.tipSlot + 1, N);
  const v7 = st.get("v7");
  check(v7?.kind === "missed" && v7.misses >= 2, `synthetic v7 status ${JSON.stringify(v7)}`);
}

// ---------- recorded rounds ----------
const count = Number(process.argv[2] ?? 20);
const first = Number((await get("/blocks?limit=1&orderBy=number:asc")).data[0].number);
const tip = Number((await get("/blockchain")).data.block.number);
const roundOf = (h: number) => Math.floor((h - first - 1) / N) + 1;
const roundStart = (r: number) => first + 1 + (r - 1) * N;
const last = roundOf(tip);
let totalMisses = 0;
let totalSkipped = 0;
let inferred = 0;
let replayed = 0;
for (let r = last; r > last - count && r > 0; r--) {
  const start = roundStart(r);
  const end = Math.min(start + N - 1, tip);
  const list = (await get(`/rounds/${r}`)).data.validators as string[];
  const raw: any[] = [];
  for (let f = start; f <= end; f += 100) raw.push(...(await get(`/blocks?number.from=${f}&number.to=${Math.min(f + 99, end)}&limit=100&orderBy=number:asc`)).data);
  const blocks: RoundBlock[] = raw.map((b) => ({ height: Number(b.number), id: b.hash, proposer: b.proposer, round: Number(b.round) }));
  const round = buildRound(r, start, list, blocks);
  const complete = blocks.length === N;
  const rows = roundSlots(round, round.tipSlot, round.tipSlot + 1, N);
  const recorded = blocks.reduce((s, b) => s + b.round, 0);
  const missedRows = rows.filter((x) => x.st.kind === "missed" && x.slot < round.tipSlot);
  const skipped = rows.filter((x) => x.st.kind === "skipped").length;
  // every block on a turn of its own proposer
  for (const [turn, f] of Object.entries(round.forged)) check(round.order[Number(turn) % N].toLowerCase() === f.publicKey.toLowerCase(), `round ${r}: block ${f.height} on turn ${turn} of someone else`);
  check(missedRows.length === recorded, `round ${r}: ${missedRows.length} missed rows, blocks record ${recorded}`);
  // the scan's names (missedBefore, per block) are the Forging View's
  const scanNames = blocks.flatMap((b) => missedBefore(list, b)).map((a) => a.toLowerCase()).sort();
  const viewNames = missedRows.map((x) => x.pk.toLowerCase()).sort();
  check(JSON.stringify(scanNames) === JSON.stringify(viewNames), `round ${r}: missedBefore and the Forging View disagree`);
  // provisional blocks: infer each block's consensus round from the round so far plus its proposer
  const inc = buildRound(r, start, list, []);
  for (const b of blocks) {
    const guess = inferRound(inc, b.proposer);
    const before = Object.keys(inc.skipped).length;
    addBlock(inc, b);
    const reproposal = Object.keys(inc.skipped).length > before;
    if (inc.count > 1 && !reproposal) check(guess === b.round, `round ${r}: block ${b.height} inferred round ${guess}, recorded ${b.round}`);
    if (inc.count > 1 && !reproposal) inferred++;
  }
  if (complete) check(rows.length === N + recorded + skipped, `round ${r}: ${rows.length} rows for ${recorded} misses + ${skipped} skipped`);
  console.log(`round ${r}${complete ? "" : " (in progress)"}: ${blocks.length} blocks, ${recorded} misses, ${skipped} skipped turns, ${rows.length} rows`);
  totalMisses += recorded;
  totalSkipped += skipped;
  replayed++;
}
console.log(`provisional blocks: ${inferred} consensus rounds inferred from the proposer`);
console.log(`\n${replayed} rounds, ${totalMisses} misses, ${totalSkipped} skipped turns: ${failures ? `${failures} FAILURES` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
