<script lang="ts">
  import Sym from "../components/Sym.svelte";
  import { SYMBOL } from "../lib/site";
  import { chain } from "../lib/chain";
  import { currentSlot, live, slotStartMs as turnStartMs } from "../lib/live.svelte";
  import { dir, forgingHealth, missed, missedCount } from "../lib/delegates.svelte";
  import { ago, agoShort, arkCompact, countdown, formatInt } from "../lib/format";
  import { untrack } from "svelte";
  import type { Delegate } from "../lib/types";
  import { forgerOf, roundEndSlot, roundSlots, validatorStatus, type TurnStatus } from "../lib/roundview";

  type Mode = "rank" | "order";
  type Tab = "active" | "standby" | "resigned";

  let mode = $state<Mode>("rank"); // always opens in Rank View
  let tab = $state<Tab>("active");
  let filter = $state("");
  let page = $state(1);
  const PAGE = 50;

  const n = $derived(chain.activeDelegates);
  const active = $derived(dir.list.filter((d) => !d.isResigned && d.rank > 0 && d.rank <= n));
  const standby = $derived(dir.list.filter((d) => !d.isResigned && !(d.rank > 0 && d.rank <= n)));
  const resigned = $derived(dir.list.filter((d) => d.isResigned));
  const byPk = $derived(new Map(dir.list.map((d) => [d.publicKey.toLowerCase(), d])));

  // Mainsail has no time slots: a "slot" is one proposal turn of the round (see lib/roundview.ts)
  const curSlot = $derived((void live.round?.count, currentSlot(live.now)));
  const tipSlot = $derived(live.round ? live.round.tipSlot : -1);
  const slotStartMs = (s: number) => turnStartMs(s, live.now);

  // ----- round status (rules and edge cases in lib/roundview.ts) -----
  type RoundStatus = TurnStatus;
  const roundEnd = $derived(live.round ? roundEndSlot(live.round, tipSlot, n) : -1);
  /** Rank View: one status per validator */
  const roundStatus = $derived.by(() => {
    const m = live.round ? validatorStatus(live.round, tipSlot, curSlot, n) : new Map<string, TurnStatus>();
    return new Map([...m].map(([k, v]) => [k.toLowerCase(), v]));
  });
  const roundStatusOf = (address: string) => roundStatus.get(address.toLowerCase());
  /** Forging View: one row per slot; grows by one row per missed slot */
  const slotRows = $derived(live.round ? roundSlots(live.round, tipSlot, curSlot, n) : []);
  const forgingNow = $derived(live.round ? byPk.get(forgerOf(live.round, curSlot, tipSlot, n)?.toLowerCase() ?? "") : undefined);
  const nextUp = $derived(live.round ? byPk.get(forgerOf(live.round, curSlot + 1, tipSlot, n)?.toLowerCase() ?? "") : undefined);
  /** the slot after this one starts a new round (if the blocks in flight arrive) */
  const nextIsNewRound = $derived(!!live.round && curSlot + 1 > roundEnd);
  const slotLeft = $derived(slotStartMs(curSlot + 1) - live.now);
  /** no block for 2 minutes (~10 missed turns in a row): the chain has stopped, countdowns mean nothing */
  const stalled = $derived(!!live.tip && live.now - live.tip.timestamp.unix * 1000 > 120_000);

  // ----- forging health (from missed-slot history) -----
  const health = (d: Delegate) => forgingHealth(d);
  /** null until a status is known (the last known one is kept while the scan catches up) */
  const healthCounts = $derived.by(() => {
    void missed.lastMissed;
    void missed.current;
    const c = { forging: 0, missed: 0, "not-forging": 0 };
    let known = 0;
    for (const d of active) {
      const h = health(d);
      if (h !== "unknown") (c[h]++, known++);
    }
    return known ? c : null;
  });

  const totalActiveVotes = $derived(active.reduce((s, d) => s + BigInt(d.votes), 0n));

  // ----- rows -----
  const rows = $derived.by(() => {
    if (mode === "order") {
      return slotRows
        .map(({ slot, pk, st }, i) => ({ pos: i + 1, d: byPk.get(pk.toLowerCase()), key: `s${slot}`, st }))
        .filter((r) => r.d) as { pos: number; d: Delegate; key: string; st?: RoundStatus }[];
    }
    const src = tab === "active" ? active : tab === "standby" ? standby : resigned;
    const f = filter.trim().toLowerCase();
    const list = f ? src.filter((d) => d.username.toLowerCase().includes(f) || d.address.toLowerCase() === f) : src;
    return list.map((d) => ({ pos: d.rank, d, key: d.publicKey, st: undefined as RoundStatus | undefined }));
  });
  const pages = $derived(Math.max(1, Math.ceil(rows.length / PAGE)));
  const visible = $derived(mode === "order" || tab === "active" ? rows : rows.slice((page - 1) * PAGE, page * PAGE));

  $effect(() => {
    void tab;
    void filter;
    page = 1;
  });

  // A new round reorders every row. Browsers keep the row under your eye in view ("scroll
  // anchoring") and drag the page along with it, so in forging order anchoring is off for the table
  // and the page jumps back to the top instead, where the new round begins.
  let shownRound = 0;
  $effect(() => {
    const r = live.round?.number ?? 0;
    if (r && shownRound && r !== shownRound && untrack(() => mode) === "order" && window.scrollY > 0) {
      window.scrollTo(0, 0);
    }
    if (r) shownRound = r;
  });

  const pct = (d: Delegate) => `${(d.production?.approval ?? 0).toFixed(2)}%`;
</script>

<div class="page">
  <div class="page-head head3">
    <div>
      <h1>Validators</h1>
      <p>Live Monitor</p>
    </div>
    {#if live.supply !== null}
      <span class="pill supply" title="Total supply, updated with every block">Supply <b class="num">{arkCompact(live.supply)}<Sym /></b></span>
    {/if}
    <div class="seg" role="tablist" aria-label="Order">
      <button class:on={mode === "rank"} onclick={() => (mode = "rank")}>Rank View</button>
      <button class:on={mode === "order"} onclick={() => (mode = "order")}>Forging View</button>
    </div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="label">Height</div>
      <div class="value">{live.tip ? formatInt(live.tip.height) : "…"}</div>
      <div class="sub">{live.tip ? ago(live.tip.timestamp.unix, live.now) : "connecting"}</div>
    </div>
    <div class="stat">
      <div class="label">Round</div>
      <div class="value">{live.round ? formatInt(live.round.number) : "…"}</div>
      <div class="sub">{live.round ? `${live.round.count} / ${n} blocks` : ""}</div>
      {#if live.round}<div class="bar" style="margin-top:6px"><div style="width:{(live.round.count / n) * 100}%"></div></div>{/if}
    </div>
    <div class="stat">
      <div class="label">Forging now</div>
      <div class="value"><a href="#/wallet/{forgingNow?.address}">{forgingNow?.username ?? "…"}</a></div>
      {#if stalled}
        <div class="sub warn" title="The chain has made no block since {live.tip ? ago(live.tip.timestamp.unix, live.now) : ''}">chain stalled</div>
      {:else}
        <div class="sub next" title={nextUp?.username}><span>next:</span><span class="nname">{nextUp?.username ?? (nextIsNewRound ? "new round" : "…")}</span><span>in {countdown(slotLeft)}</span></div>
      {/if}
    </div>
    <div class="stat">
      <div class="label">Forging status</div>
      <div class="health">
        <div title="Forging"><div class="value green">{healthCounts ? healthCounts.forging : "…"}</div><div class="sub">forging</div></div>
        <div title="Missed their last turn"><div class="value warn">{healthCounts ? healthCounts.missed : "…"}</div><div class="sub">missed</div></div>
        <div title="Missed several turns in a row over at least ~3.5 minutes"><div class="value red">{healthCounts ? healthCounts["not-forging"] : "…"}</div><div class="sub">dead</div></div>
      </div>
    </div>
    <div class="stat">
      <div class="label">Missed blocks ({missed.windowHours} h)</div>
      <div class="value">{missed.progress > 0 ? formatInt(missed.total) : "…"}</div>
      <div class="sub">
        {#if missed.ready}{Object.keys(missed.counts).length} validators{:else}scanning {Math.round(missed.progress * 100)}%{/if}
      </div>
    </div>
    <div class="stat">
      <div class="label">Active votes</div>
      <div class="value">{arkCompact(totalActiveVotes)}<Sym /></div>
      <div class="sub" title="Votes on the top {n} validators as a share of the total supply">{live.supply ? `${(Number((totalActiveVotes * 10000n) / live.supply) / 100).toFixed(2)}% of supply` : "…"}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head" class:tight={mode === "rank"}>
      {#if mode === "rank"}
        <div class="seg">
          <button class:on={tab === "active"} onclick={() => (tab = "active")}>Active<span class="count faint">{active.length}</span></button>
          <button class:on={tab === "standby"} onclick={() => (tab = "standby")}>Standby<span class="count faint">{standby.length}</span></button>
          <button class:on={tab === "resigned"} onclick={() => (tab = "resigned")}>Resigned<span class="count faint">{resigned.length}</span></button>
        </div>
        <input class="text" placeholder="Filter by name" bind:value={filter} aria-label="Filter validators" />
      {:else}
        <h2>Round {live.round ? formatInt(live.round.number) : ""}</h2>
      {/if}
    </div>
    {#if !dir.loaded}
      <div class="notice" style="border:0">Loading validators…</div>
    {:else}
      <div class="table-wrap" class:no-anchor={mode === "order"}>
        <table class="dense" class:rank={mode === "rank"}>
          <thead>
            <tr>
              <th class="right" title={mode === "order" ? "Position in this round" : "Rank"}>#</th>
              <th>Validator</th>
              <th class="c-round">Round</th>
              {#if mode === "order"}<th class="right c-rank">Rank</th>{/if}
              <th class="right c-votes" title="Votes ({SYMBOL})">Votes</th>
              <th class="right c-pct">%</th>
              <th class="right c-voters" title="Wallets voting for the validator">Voters</th>
              <th class="right c-blocks" title="Blocks produced">Blocks</th>
              <th class="right c-missed" title="Missed turns in the last {missed.windowHours} hours">Missed</th>
              <th class="right c-last" title="Time since the last forged block">Last</th>
            </tr>
          </thead>
          <tbody>
            {#each visible as { pos, d, key, st: slotSt } (key)}
              {@const st = slotSt ?? roundStatusOf(d.publicKey)}
              {@const h = st ? health(d) : null}
              <tr
                class:current={st?.kind === "forging"}
                class:flash={st?.kind === "forged" && st.height === live.tip?.height}
                class:dim={mode === "order" && st?.kind === "forged"}
              >
                <td class="num faint right">{pos || "–"}</td>
                <td>
                  <span class="name">
                    {#if h}<span class="hdot {h}" title={h === "forging" ? "Forging" : h === "missed" ? "Missed its last turn" : h === "unknown" ? "Checking recent blocks…" : "Dead: missed its last turns in a row (several minutes without a block)"}></span>{/if}
                    <a class="trunc" href="#/wallet/{d.address}" title={d.username}>{d.username}</a>
                  </span>
                </td>
                <td class="c-round">
                  {#if !st}
                    <span class="faint">–</span>
                  {:else if st.kind === "forged"}
                    <a class="pill rp green" href="#/block/{st.height}" title={st.blocks > 1 ? `Forged ${st.blocks} blocks this round (extra turns after missed turns); last #${formatInt(st.height)}` : `Forged block #${formatInt(st.height)}`}>{formatInt(st.height)}{#if st.blocks > 1}<span class="times">×{st.blocks}</span>{/if}</a>
                  {:else if st.kind === "forging"}
                    <span class="pill rp accent" title={st.turn > 1 ? `Forging now (turn ${st.turn} this round)` : "Forging now"}><span class="dot pulse"></span>Now{#if st.turn > 1}<span class="times">#{st.turn}</span>{/if}</span>
                  {:else if st.kind === "late"}
                    <span class="pill rp warn" title="Its turn timed out, block not seen yet"><span class="dot pulse"></span>Late</span>
                  {:else if st.kind === "skipped"}
                    <span class="pill rp" title="Turn passed while another proposer's block was being re-proposed: not a miss">–</span>
                  {:else if st.kind === "missed"}
                    <span class="pill rp red" title={st.misses > 1 ? `Missed ${st.misses} turns this round` : "Missed its turn"}>Missed{#if st.misses > 1}<span class="times">×{st.misses}</span>{/if}</span>
                  {:else}
                    <span class="pill rp" class:accent={st.next} title={(st.turn > 1 ? `Extra turn ${st.turn}: the round runs long after missed turns. ` : "") + (stalled ? "Waiting: the chain has stalled" : st.next ? "Proposes next" : "Expected time until its turn (if every turn before it produces a block)")}>{stalled ? "Waiting" : countdown(slotStartMs(st.slot) - live.now)}{#if st.turn > 1}<span class="times">#{st.turn}</span>{/if}</span>
                  {/if}
                </td>
                {#if mode === "order"}<td class="num muted right c-rank">{d.rank}</td>{/if}
                <td class="right c-votes">{arkCompact(d.votes)}<Sym /></td>
                <td class="right muted c-pct">{pct(d)}</td>
                <td class="right c-voters">{dir.voters[d.publicKey] !== undefined ? formatInt(dir.voters[d.publicKey]) : ""}{#if dir.voters[d.publicKey] === undefined}<span class="skeleton" style="width:30px"></span>{/if}</td>
                <td class="right c-blocks">{formatInt(d.blocks.produced)}</td>
                <td class="right c-missed" class:warn={missedCount(d.publicKey) > 0}>{missed.progress > 0 ? missedCount(d.publicKey) : ""}</td>
                <td class="right c-last">
                  {#if d.blocks.last}
                    <a href="#/block/{d.blocks.last.height}" title="#{formatInt(d.blocks.last.height)} · {ago(d.blocks.last.timestamp.unix, live.now)}">{agoShort(d.blocks.last.timestamp.unix, live.now)}</a>
                  {:else}<span class="faint">–</span>{/if}
                </td>
              </tr>
            {:else}
              <tr><td colspan="10" class="muted">{mode === "order" ? "Loading the round…" : "No validators match."}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if mode === "rank" && tab !== "active" && pages > 1}
        <div class="pager">
          <button class="btn" disabled={page <= 1} onclick={() => page--}>Prev</button>
          <span class="muted">Page {page} of {pages}</span>
          <button class="btn" disabled={page >= pages} onclick={() => page++}>Next</button>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* wide enough: three columns with equal sides, so the supply pill sits in the middle of the whole
     row (not of the space left between title and switch); narrower, the usual wrapping head */
  @media (min-width: 620px) {
    .head3 {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
    }
    .head3 > :first-child {
      grid-column: 1;
    }
    .head3 > .supply {
      grid-column: 2;
    }
    .head3 > .seg {
      grid-column: 3;
      justify-self: end;
    }
  }
  .times {
    margin-left: 4px;
    opacity: 0.75;
    font-size: 11px;
  }
  /* one line whatever the name: a long name is cut, the countdown stays (a wrap would make the tile row jump) */
  .sub.next {
    display: flex;
    gap: 0.3em;
    white-space: nowrap;
  }
  .nname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* the tabs and filter fit in the same 52 px as the Forging View title */
  .card-head.tight {
    padding-top: 6.5px;
    padding-bottom: 6.5px;
  }
  .supply {
    font-size: 13px;
  }
  .supply b {
    color: var(--text);
    font-weight: 600;
  }
  /* each count sits above its own label */
  /* Every round pill is as wide as a block height, so the column does not resize as countdowns
     turn into forged heights during the round. */
  .no-anchor {
    overflow-anchor: none;
  }
  .rp {
    justify-content: center;
    min-width: calc(10ch + 18px);
  }
  .health {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 10px;
  }
  .health .sub {
    line-height: 1.25;
    overflow: visible; /* fixed labels: never cut them */
  }
  /* narrow tiles: columns as wide as their labels, spread across the tile */
  @media (max-width: 420px) {
    .health {
      grid-template-columns: repeat(3, auto);
      justify-content: space-between;
      column-gap: 6px;
    }
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  /* columns drop out least-important first; breakpoints from the measured natural widths */
  @media (max-width: 950px) {
    .c-rank {
      display: none;
    }
  }
  @media (max-width: 885px) {
    .c-pct {
      display: none;
    }
  }
  @media (max-width: 815px) {
    .c-voters {
      display: none;
    }
  }
  @media (max-width: 735px) {
    .c-blocks {
      display: none;
    }
  }
  @media (max-width: 560px) {
    .c-last {
      display: none;
    }
  }
  /* the Round header sits over the middle of its pills */
  .c-round {
    text-align: center;
  }
  /* phones: Forging View keeps the round pills, Rank View keeps the votes instead */
  @media (max-width: 480px) {
    .c-votes {
      display: none;
    }
    table.rank .c-votes {
      display: table-cell;
    }
    table.rank .c-round {
      display: none;
    }
  }
  @media (max-width: 371px) {
    .c-missed {
      display: none;
    }
  }
  .name .trunc {
    --trunc: 170px;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.35;
  }
  @media (max-width: 659px) {
    .name .trunc {
      --trunc: 112px;
    }
  }
  @media (max-width: 400px) {
    .name .trunc {
      --trunc: 100px;
    }
  }
  .hdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    flex: none;
  }
  .hdot.missed {
    background: var(--warn);
  }
  .hdot.not-forging {
    background: var(--red);
  }
  .hdot.unknown {
    background: var(--faint);
    opacity: 0.6;
  }
  a.pill:hover {
    text-decoration: none;
    filter: brightness(1.15);
  }
  .pager {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    padding: 12px;
    border-top: 1px solid var(--border);
  }
  .card-head input {
    width: 220px;
  }
  @media (max-width: 700px) {
    .card-head {
      flex-wrap: wrap;
    }
    .card-head input {
      width: 100%;
    }
  }
</style>
