<script lang="ts">
  import { SYMBOL, TOKEN } from "../lib/site";
  import { chain, slotAt, slotOf, slotStartMs } from "../lib/chain";
  import { live } from "../lib/live.svelte";
  import { dir, missed, missedSinceLastBlock, wantVoters } from "../lib/delegates.svelte";
  import { ago, agoShort, arkCompact, countdown, formatInt } from "../lib/format";
  import { load, save } from "../lib/storage";
  import type { Delegate } from "../lib/types";

  type Mode = "rank" | "order";
  type Tab = "active" | "standby" | "resigned";

  let mode = $state<Mode>(load<Mode>("ark-explorer:delegates-mode") ?? "rank");
  let tab = $state<Tab>("active");
  let filter = $state("");
  let page = $state(1);
  const PAGE = 100;

  $effect(() => save("ark-explorer:delegates-mode", mode));

  const n = $derived(chain.activeDelegates);
  const active = $derived(dir.list.filter((d) => !d.isResigned && d.rank > 0 && d.rank <= n));
  const standby = $derived(dir.list.filter((d) => !d.isResigned && !(d.rank > 0 && d.rank <= n)));
  const resigned = $derived(dir.list.filter((d) => d.isResigned));
  const byPk = $derived(new Map(dir.list.map((d) => [d.publicKey, d])));

  const curSlot = $derived(slotAt(live.now));
  const tipSlot = $derived(live.tip ? slotOf(live.tip.timestamp.epoch) : 0);

  // ----- round status per active delegate -----
  type RoundStatus =
    | { kind: "forged"; height: number; slot: number }
    | { kind: "missed"; slot: number }
    | { kind: "forging"; slot: number }
    | { kind: "late"; slot: number }
    | { kind: "pending"; slot: number; eta: number; next: boolean };

  /** Slot of each delegate's turn in the current round, in rotation order. */
  const rotation = $derived.by(() => {
    const r = live.round;
    if (!r) return [] as { pk: string; slot: number }[];
    return Array.from({ length: n }, (_, p) => {
      const slot = r.firstSlot + p;
      return { pk: r.order[slot % n], slot };
    });
  });

  const roundStatus = $derived.by(() => {
    const r = live.round;
    const out = new Map<string, RoundStatus>();
    if (!r) return out;
    for (const { pk, slot } of rotation) {
      const again = slot + n; // second turn when slots were missed earlier in the round
      const f = r.forged[again] ?? r.forged[slot];
      let st: RoundStatus;
      if (f) st = { kind: "forged", height: f.height, slot: r.forged[again] ? again : slot };
      else if (slot < tipSlot) st = { kind: "missed", slot };
      else if (slot === curSlot) st = { kind: "forging", slot };
      else if (slot < curSlot) st = { kind: "late", slot };
      else st = { kind: "pending", slot, eta: slotStartMs(slot) - live.now, next: slot === curSlot + 1 };
      // a missed delegate gets another turn if the round runs past its first pass
      if (st.kind === "missed" && again === curSlot) st = { kind: "forging", slot: again };
      out.set(pk, st);
    }
    return out;
  });

  const forgingNow = $derived(live.round ? byPk.get(live.round.order[curSlot % n]) : undefined);
  const nextUp = $derived(live.round ? byPk.get(live.round.order[(curSlot + 1) % n]) : undefined);
  const slotLeft = $derived(slotStartMs(curSlot + 1) - live.now);

  // ----- forging health (from missed-slot history) -----
  function health(d: Delegate): "forging" | "missed" | "not-forging" {
    const m = missedSinceLastBlock(d);
    return m === 0 ? "forging" : m === 1 ? "missed" : "not-forging";
  }
  const healthCounts = $derived.by(() => {
    void missed.lastMissed;
    const c = { forging: 0, missed: 0, "not-forging": 0 };
    for (const d of active) c[health(d)]++;
    return c;
  });

  const totalActiveVotes = $derived(active.reduce((s, d) => s + BigInt(d.votes), 0n));

  // ----- rows -----
  const rows = $derived.by(() => {
    if (mode === "order") {
      return rotation.map(({ pk }, i) => ({ pos: i + 1, d: byPk.get(pk) })).filter((r) => r.d) as { pos: number; d: Delegate }[];
    }
    const src = tab === "active" ? active : tab === "standby" ? standby : resigned;
    const f = filter.trim().toLowerCase();
    const list = f ? src.filter((d) => d.username.toLowerCase().includes(f) || d.address.toLowerCase() === f) : src;
    return list.map((d) => ({ pos: d.rank, d }));
  });
  const pages = $derived(Math.max(1, Math.ceil(rows.length / PAGE)));
  const visible = $derived(mode === "order" || tab === "active" ? rows : rows.slice((page - 1) * PAGE, page * PAGE));

  $effect(() => {
    void tab;
    void filter;
    page = 1;
  });
  $effect(() => {
    const pks = visible.map((r) => r.d.publicKey);
    const t = setTimeout(() => wantVoters(pks), 600);
    return () => clearTimeout(t);
  });

  const pct = (d: Delegate) => `${(d.production?.approval ?? 0).toFixed(2)}%`;
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Validators</h1>
      <p>Live forging monitor and validator list for ARK mainnet.</p>
    </div>
    <div class="seg" role="tablist" aria-label="Order">
      <button class:on={mode === "rank"} onclick={() => (mode = "rank")}>By rank</button>
      <button class:on={mode === "order"} onclick={() => (mode = "order")}>Forging order</button>
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
      <div class="sub">next: {nextUp?.username ?? "…"} in {countdown(slotLeft)}</div>
    </div>
    <div class="stat">
      <div class="label">Forging status</div>
      <div class="health">
        <div title="Forging"><div class="value green">{healthCounts.forging}</div><div class="sub">forging</div></div>
        <div title="Missed their last slot"><div class="value warn">{healthCounts.missed}</div><div class="sub">missed</div></div>
        <div title="Missed several slots in a row"><div class="value red">{healthCounts["not-forging"]}</div><div class="sub">dead</div></div>
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
      <div class="value">{arkCompact(totalActiveVotes)}</div>
      <div class="sub">{TOKEN} voting for the top {n}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      {#if mode === "rank"}
        <div class="seg">
          <button class:on={tab === "active"} onclick={() => (tab = "active")}>Active <span class="faint">{active.length}</span></button>
          <button class:on={tab === "standby"} onclick={() => (tab = "standby")}>Standby <span class="faint">{standby.length}</span></button>
          <button class:on={tab === "resigned"} onclick={() => (tab = "resigned")}>Resigned <span class="faint">{resigned.length}</span></button>
        </div>
        <input class="text" placeholder="Filter by name" bind:value={filter} aria-label="Filter validators" />
      {:else}
        <h2>Round {live.round ? formatInt(live.round.number) : ""}</h2>
      {/if}
    </div>
    {#if !dir.loaded}
      <div class="notice" style="border:0">Loading validators…</div>
    {:else}
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th class="right" title={mode === "order" ? "Position in this round" : "Rank"}>#</th>
              <th>Validator</th>
              <th>Round</th>
              {#if mode === "order"}<th class="right c-rank">Rank</th>{/if}
              <th class="right c-votes" title="Votes ({TOKEN})">Votes</th>
              <th class="right c-pct">%</th>
              <th class="right c-voters" title="Voters holding at least 1 {TOKEN}">Voters</th>
              <th class="right c-blocks" title="Blocks produced">Blocks</th>
              <th class="right c-missed" title="Missed slots in the last {missed.windowHours} hours">Missed</th>
              <th class="right c-last" title="Time since the last forged block">Last</th>
            </tr>
          </thead>
          <tbody>
            {#each visible as { pos, d } (d.publicKey)}
              {@const st = roundStatus.get(d.publicKey)}
              {@const h = st ? health(d) : null}
              <tr
                class:current={st?.kind === "forging"}
                class:flash={st?.kind === "forged" && st.height === live.tip?.height}
                class:dim={mode === "order" && st?.kind === "forged"}
              >
                <td class="num faint right">{pos || "–"}</td>
                <td>
                  <span class="name">
                    {#if h}<span class="hdot {h}" title={h === "forging" ? "Forging" : h === "missed" ? "Missed last slot" : "Dead: missed several slots in a row"}></span>{/if}
                    <a class="trunc" href="#/wallet/{d.address}" title={d.username}>{d.username}</a>
                  </span>
                </td>
                <td>
                  {#if !st}
                    <span class="faint">–</span>
                  {:else if st.kind === "forged"}
                    <a class="pill green" href="#/block/{st.height}" title="Forged block #{formatInt(st.height)}">{formatInt(st.height)}</a>
                  {:else if st.kind === "forging"}
                    <span class="pill accent" title="Forging now"><span class="dot pulse"></span>Now</span>
                  {:else if st.kind === "late"}
                    <span class="pill warn" title="Slot passed, block not seen yet"><span class="dot pulse"></span>Late</span>
                  {:else if st.kind === "missed"}
                    <span class="pill red">Missed</span>
                  {:else}
                    <span class="pill" class:accent={st.next} title={st.next ? "Forges next" : "Time until its slot"}>{countdown(st.eta)}</span>
                  {/if}
                </td>
                {#if mode === "order"}<td class="num muted right c-rank">{d.rank}</td>{/if}
                <td class="right c-votes">{arkCompact(d.votes)}</td>
                <td class="right muted c-pct">{pct(d)}</td>
                <td class="right c-voters">{dir.voters[d.publicKey] !== undefined ? formatInt(dir.voters[d.publicKey]) : ""}{#if dir.voters[d.publicKey] === undefined}<span class="skeleton" style="width:30px"></span>{/if}</td>
                <td class="right c-blocks">{formatInt(d.blocks.produced)}</td>
                <td class="right c-missed" class:warn={(missed.counts[d.publicKey] ?? 0) > 0}>{missed.progress > 0 ? (missed.counts[d.publicKey] ?? 0) : ""}</td>
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
  /* each count sits above its own label */
  .health {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 10px;
  }
  .health .sub {
    line-height: 1.25;
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  /* columns drop out least-important first; breakpoints from the measured natural widths */
  @media (max-width: 905px) {
    .c-rank {
      display: none;
    }
  }
  @media (max-width: 840px) {
    .c-pct {
      display: none;
    }
  }
  @media (max-width: 770px) {
    .c-voters {
      display: none;
    }
  }
  @media (max-width: 690px) {
    .c-blocks {
      display: none;
    }
  }
  @media (max-width: 560px) {
    .c-last {
      display: none;
    }
  }
  @media (max-width: 480px) {
    .c-votes {
      display: none;
    }
  }
  @media (max-width: 360px) {
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
