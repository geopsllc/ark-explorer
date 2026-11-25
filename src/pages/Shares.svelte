<script lang="ts">
  // Hidden page (#/shares, or type "shares" in search): what sharing validators really pay voters.
  // Data is /shares.json, made every 6 hours by tools/ark-share in the deploy workflow; this page
  // sends no API requests of its own.
  import { onMount, untrack } from "svelte";
  import Sym from "../components/Sym.svelte";
  import Addr from "../components/Addr.svelte";
  import { ago, agoShort, formatInt } from "../lib/format";
  import { route, setQuery } from "../lib/router.svelte";
  import { get } from "../lib/api";
  import { live } from "../lib/live.svelte";

  type Row = {
    rank: number; username: string; address: string; payer: string | null;
    status: "sharing" | "irregular" | "stopped";
    share: number; shareRaw: number; confidence: number; effective: number; operator: number; kept: number;
    votes: number; votesWindow?: number | null; voters: number; votersPaid: number; forgedPerDay: number;
    intervalH: number; payoutsPerDay: number; lastPayout: number;
    delayH: number | null; firstPayoutH: number | null; capArk: number | null; minArk: number | null;
    perRun: number[]; window: { from: number; to: number; runs: number };
    operators: { address: string; pct: number; voter: boolean }[]; flags: string[]; vendor: string;
  };
  type Data = { generated: number; rewardPerBlock: number; delegates: Row[] };

  let data = $state<Data | null>(null);
  let error = $state("");
  let open = $state<string | null>(null);

  const PRESETS = [1_000, 10_000, 100_000];
  let amountText = $state(route.query.amount ?? "1000");
  const amount = $derived(Math.max(0, Number(amountText.replace(/[,\s]/g, "")) || 0));
  // keep the amount in the URL (shareable); only `amount` is tracked, not the route it writes
  $effect(() => {
    const a = amount;
    untrack(() => setQuery({ amount: a === 1000 ? undefined : a }));
  });

  type SortKey = "reward" | "share" | "votes" | "voters" | "rank" | "last";
  let sort = $state<SortKey>("reward");
  let desc = $state(true);
  function sortBy(k: SortKey) {
    if (sort === k) desc = !desc;
    else (sort = k), (desc = k !== "rank");
  }

  onMount(async () => {
    try {
      const res = await fetch("/shares.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status === 404 ? "not generated yet" : `HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    checkLastPayouts();
    checkVotes();
  });

  // Votes change between crawls (a big voter moving shifts everyone's cut), so the calculator uses
  // the live vote totals: one request for all active delegates.
  let liveVotes = $state<Record<string, number>>({});
  async function checkVotes() {
    try {
      const body = await get(`/delegates?limit=100`, "background");
      for (const v of body.data ?? []) liveVotes[v.address] = Number(v.votes) / 1e8;
    } catch {
      /* keep the crawl's value */
    }
  }
  const votesOf = (d: Row) => liveVotes[d.address] ?? d.votes;

  // The crawl runs every 6 hours; the latest payout is checked live (one request per delegate)
  // so "Last" and "gone dark" are current.
  let liveLast = $state<Record<string, number>>({});
  async function checkLastPayouts() {
    await Promise.all(
      (data?.delegates ?? []).map(async (d) => {
        try {
          const body = await get(`/wallets/${d.payer ?? d.address}/transactions/sent?typeGroup=1&type=6&orderBy=timestamp:desc&limit=1`, "background");
          const t = body.data?.[0]?.timestamp?.unix;
          if (t) liveLast[d.address] = t;
        } catch {
          /* keep the crawl's value */
        }
      }),
    );
  }
  const lastOf = (d: Row) => Math.max(d.lastPayout, liveLast[d.address] ?? 0);
  /** gone dark: the crawl said stopped and no payout has shown up since (48 h without one) */
  const isDark = (d: Row) => d.status === "stopped" && Date.now() / 1000 - lastOf(d) > 48 * 3600;

  // First payout: pools pay for blocks up to the payout (no delay) or a day behind, so the measured
  // delay is snapped to whole days; unknown counts as no delay. A new voter waits at most the delay
  // plus one payout interval.
  function nominalInterval(h: number): number {
    for (const n of [24, 12, 8, 6]) if (Math.abs(h - n) <= n * 0.17) return n;
    return h;
  }
  const delayDays = (d: Row) => (d.delayH === null || d.delayH < 12 ? 0 : Math.round(d.delayH / 24));
  const firstPayoutMax = (d: Row) => delayDays(d) * 24 + nominalInterval(d.intervalH);
  const within = (h: number) => (h < 24 ? `≤ ${Math.round(h)} h` : `≤ ${Math.round(h / 24)} d`);

  /** Daily reward for voting `x` ARK: share × forged/day × your weight / (votes + your vote).
   *  Minimum and maximum voting weights apply; gone-dark validators pay nothing. */
  function reward(d: Row, x: number): { day: number | null; note?: string } {
    if (isDark(d)) return { day: null, note: "not paying" };
    if (!x) return { day: null };
    if (d.minArk && x < d.minArk) return { day: 0, note: `below the ~${formatInt(Math.round(d.minArk))} Ѧ minimum` };
    const w = d.capArk ? Math.min(x, d.capArk) : x;
    return { day: ((d.shareRaw / 100) * d.forgedPerDay * w) / (votesOf(d) + x), note: d.capArk && x > d.capArk ? `capped at ~${formatInt(d.capArk)} Ѧ` : undefined };
  }

  const rows = $derived.by(() => {
    if (!data) return [];
    const list = data.delegates.map((d) => ({ d, r: reward(d, amount) }));
    const val = (x: (typeof list)[number]): number => {
      switch (sort) {
        case "reward": return x.r.day ?? -1;
        case "share": return isDark(x.d) ? -1 : x.d.shareRaw;
        case "votes": return votesOf(x.d);
        case "voters": return x.d.voters;
        case "rank": return x.d.rank;
        case "last": return lastOf(x.d);
      }
    };
    return list.sort((a, b) => (desc ? val(b) - val(a) : val(a) - val(b)) || a.d.rank - b.d.rank);
  });

  const paying = $derived(data ? data.delegates.filter((d) => !isDark(d)) : []);
  const dark = $derived(data ? data.delegates.filter((d) => isDark(d)) : []);
  const medianShare = $derived.by(() => {
    const s = paying.map((d) => d.share).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  });
  const best = $derived(rows.find((x) => x.r.day !== null && x.d.status === "sharing"));

  const fmtArk = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
  const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));
  function schedule(d: Row): string {
    const h = d.intervalH;
    if (h >= 20 && h <= 28) return "daily";
    if (h >= 140 && h <= 196) return "weekly";
    if (h < 20) return `${Math.round(24 / h)}× a day`;
    return `every ${Math.round(h / 24)} days`;
  }
  /** flags not already shown in their own row */
  const notes = (d: Row) => d.flags.filter((f) => !f.startsWith("payout delay"));
  const hours = (h: number) => (h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);
  const now = $derived(live.now || Date.now());
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Reward Sharing</h1>
      <p>What validators really pay their voters, measured from their payouts</p>
    </div>
    {#if data}<span class="pill" title="Measured over each validator's last 7 days of payouts">Updated {ago(data.generated, now)}</span>{/if}
  </div>

  {#if error}
    <div class="notice">Share data is not available ({error}).</div>
  {:else if !data}
    <div class="notice">Loading share data…</div>
  {:else}
    <div class="stats">
      <div class="stat">
        <div class="label">Sharing validators</div>
        <div class="value">{paying.length}</div>
        <div class="sub">public, 50% or more</div>
      </div>
      <div class="stat">
        <div class="label">Median share</div>
        <div class="value">{medianShare ?? "–"}%</div>
        <div class="sub">to voters, of all forged</div>
      </div>
      <div class="stat">
        <div class="label">Best for {compact(amount)}<Sym /></div>
        <div class="value">{best ? best.d.username : "–"}</div>
        <div class="sub">{best?.r.day ? `${fmtArk(best.r.day)} Ѧ a day` : ""}</div>
      </div>
      <div class="stat">
        <div class="label">Gone dark</div>
        <div class="value" class:red={dark.length > 0}>{dark.length}</div>
        <div class="sub">stopped paying this month</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>If you vote</h2>
        <div class="calc">
          <div class="seg" role="tablist" aria-label="Amount">
            {#each PRESETS as p}
              <button class:on={amount === p} onclick={() => (amountText = String(p))}>{compact(p)}<Sym /></button>
            {/each}
          </div>
          <label class="amount">
            <input class="text num" inputmode="decimal" bind:value={amountText} aria-label="Amount to vote (ARK)" />
            <Sym />
          </label>
        </div>
      </div>
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th class="right sort" onclick={() => sortBy("rank")} aria-sort={sort === "rank" ? (desc ? "descending" : "ascending") : undefined}>#</th>
              <th>Validator</th>
              <th class="right sort" onclick={() => sortBy("share")} title="What a paid voter receives, as a share of their proportional cut of everything forged">Share{sort === "share" ? (desc ? " ↓" : " ↑") : ""}</th>
              <th class="right sort" onclick={() => sortBy("reward")} title="Estimated reward for voting the amount above">Per day{sort === "reward" ? (desc ? " ↓" : " ↑") : ""}</th>
              <th class="right hide-sm" title="Yearly return of the daily reward, not compounded">APR</th>
              <th class="hide-md">Payouts</th>
              <th class="right hide-md" title="Longest wait from voting to the first payout: the payout delay (none or whole days) plus one payout interval">First payout</th>
              <th class="right sort hide-lg" onclick={() => sortBy("voters")} title="Voters paid / voters with at least 1 Ѧ">Voters{sort === "voters" ? (desc ? " ↓" : " ↑") : ""}</th>
              <th class="right sort hide-lg" onclick={() => sortBy("votes")}>Votes{sort === "votes" ? (desc ? " ↓" : " ↑") : ""}</th>
              <th class="right sort hide-xs" onclick={() => sortBy("last")} title="Time since the last payout">Last{sort === "last" ? (desc ? " ↓" : " ↑") : ""}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as { d, r } (d.address)}
              <tr class="row" class:dark={isDark(d)} class:sel={open === d.address} onclick={() => (open = open === d.address ? null : d.address)}>
                <td class="num faint right">{d.rank}</td>
                <td>
                  <span class="name">
                    <span class="chev" aria-hidden="true">{open === d.address ? "▾" : "▸"}</span>
                    <a class="trunc" href="#/wallet/{d.address}" onclick={(e) => e.stopPropagation()}>{d.username}</a>
                    {#if isDark(d)}<span class="pill red" title="Was sharing, no payout for {ago(lastOf(d), now)}">Gone dark</span>
                    {:else if d.status === "irregular"}<span class="pill warn" title="Payouts don't follow vote weight consistently">Irregular</span>{/if}
                  </span>
                </td>
                <td class="right share" class:faint={isDark(d)}>
                  {d.share}%{#if d.effective < d.share - 2}<span class="eff" title="Effective: everything paid to voters / everything forged">{Math.round(d.effective)}% eff.</span>{/if}
                </td>
                <td class="right">
                  {#if r.day === null}<span class="faint">{r.note ?? "–"}</span>
                  {:else if r.day === 0}<span class="warn" title={r.note}>0<Sym /></span>
                  {:else}<span title={r.note}>{fmtArk(r.day)}<Sym />{#if r.note}<span class="warn">*</span>{/if}</span>{/if}
                </td>
                <td class="right muted hide-sm">{r.day && amount ? ((r.day * 365) / amount * 100).toFixed(1) + "%" : "–"}</td>
                <td class="muted hide-md">{schedule(d)}</td>
                <td class="right muted hide-md" title={d.delayH !== null ? `Pays ${delayDays(d) ? delayDays(d) + " day(s) behind" : "with no delay"} (measured ${d.delayH} h), every ~${nominalInterval(d.intervalH)} h` : `No new voter to measure from: assumed no delay, every ~${nominalInterval(d.intervalH)} h`}>{within(firstPayoutMax(d))}</td>
                <td class="right hide-lg">{formatInt(d.votersPaid)}<span class="faint">/{formatInt(d.voters)}</span></td>
                <td class="right hide-lg">{compact(votesOf(d))}<Sym /></td>
                <td class="right hide-xs" class:red={isDark(d)} title={liveLast[d.address] ? "Checked live" : "From the last crawl"}>{agoShort(lastOf(d), now)}</td>
              </tr>
              {#if open === d.address}
                <tr class="details">
                  <td colspan="10">
                    <div class="kv">
                      <div class="k">Share</div>
                      <div>{d.share}% <span class="faint">(measured {d.shareRaw.toFixed(2)}%, confidence {Math.round(d.confidence * 100)}%)</span></div>
                      <div class="k">Split of forged</div>
                      <div>
                        <span class="green">{d.effective}% voters</span> ·
                        <span>{d.operator}% operator</span> ·
                        <span class="muted">{Math.max(0, d.kept).toFixed(1)}% kept or paid separately</span>
                      </div>
                      <div class="k">Payouts</div>
                      <div>
                        {schedule(d)} <span class="faint">(every {hours(d.intervalH)}, {d.window.runs} payouts measured)</span>
                        {#if d.perRun.length}<div class="runs">{#each d.perRun as p}<span class="pill" class:warn={Math.abs(p - d.effective) > 3}>{p}%</span>{/each}</div>{/if}
                      </div>
                      <div class="k">Payout delay</div>
                      <div>
                        {delayDays(d) ? `${delayDays(d)} day${delayDays(d) > 1 ? "s" : ""}` : "none"}
                        <span class="faint">· {d.delayH !== null ? `measured ${d.delayH} h` : "no new voter to measure from, assumed none"} · a new voter's first payout {within(firstPayoutMax(d))}</span>
                      </div>
                      {#if d.minArk || d.capArk}
                        <div class="k">Voting weight</div>
                        <div>
                          {#if d.minArk}minimum ~{formatInt(Math.round(d.minArk))}<Sym />{/if}{#if d.minArk && d.capArk} · {/if}{#if d.capArk}maximum ~{formatInt(d.capArk)}<Sym />{/if}
                        </div>
                      {/if}
                      {#if d.operators.length}
                        <div class="k">Operator addresses</div>
                        <div class="ops">{#each d.operators as o}<span><Addr address={o.address} /> <span class="faint">{o.pct}%</span></span>{/each}</div>
                      {/if}
                      {#if d.payer}
                        <div class="k">Pays from</div>
                        <div><Addr address={d.payer} /></div>
                      {/if}
                      {#if notes(d).length}
                        <div class="k">Notes</div>
                        <div><ul class="flags">{#each notes(d) as f}<li>{f}</li>{/each}</ul></div>
                      {/if}
                      {#if d.vendor}
                        <div class="k">Payout memo</div>
                        <div class="muted trunc">{d.vendor}</div>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/if}
            {:else}
              <tr><td colspan="10" class="muted">No sharing validators found.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
    <p class="foot faint">
      Estimates assume the validator keeps its current share, votes and forging rate, and that your vote is added to its current votes (checked live).
      Shares are rounded down to a whole percent. Validators with fewer than 20 voters, paying by single transfers, or paying more often than
      every 6 hours are treated as private pools and left out, as are validators sharing less than 50% or paying less often than daily.
      The last payout and vote totals are checked live; everything else comes from the crawl every 6 hours.
    </p>
  {/if}
</div>

<style>
  h2 {
    font-size: 15px;
    margin: 0;
  }
  .calc {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .amount {
    display: inline-flex;
    align-items: center;
  }
  .amount input {
    width: 110px;
    text-align: right;
  }
  th.sort {
    cursor: pointer;
    user-select: none;
  }
  th.sort:hover {
    color: var(--muted);
  }
  tr.row {
    cursor: pointer;
  }
  tr.sel td {
    background: var(--accent-soft);
  }
  tr.dark td {
    opacity: 0.75;
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
  }
  @media (max-width: 480px) {
    .name {
      max-width: 170px;
    }
    .name .pill {
      padding: 1px 6px;
      font-size: 11px;
    }
    .calc .seg {
      display: none;
    }
    .eff {
      display: none;
    }
    table.dense :global(th),
    table.dense :global(td) {
      padding-left: 8px;
      padding-right: 8px;
    }
  }
  .chev {
    color: var(--faint);
    font-size: 13px;
    line-height: 1;
    width: 12px;
  }
  .share {
    font-weight: 600;
  }
  .eff {
    margin-left: 6px;
    font-weight: 400;
    font-size: 11px;
    color: var(--warn);
  }
  tr.details > td {
    padding: 0;
    background: var(--card);
    white-space: normal;
  }
  tr.details:hover > td {
    background: var(--card);
  }
  .runs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .ops {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .flags {
    margin: 0;
    padding-left: 18px;
    color: var(--muted);
  }
  .foot {
    font-size: 12px;
    margin: 12px 4px 0;
    line-height: 1.5;
  }
</style>
