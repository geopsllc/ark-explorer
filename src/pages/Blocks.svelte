<script lang="ts">
  import Sym from "../components/Sym.svelte";
  import { onDestroy, untrack } from "svelte";
  import Addr from "../components/Addr.svelte";
  import Pager from "../components/Pager.svelte";
  import { get } from "../lib/api";
  import { live } from "../lib/live.svelte";
  import { loader } from "../lib/loader.svelte";
  import { route, setQuery } from "../lib/router.svelte";
  import { ago, agoShort, arkCompact, formatInt } from "../lib/format";
  import type { Block } from "../lib/types";

  const SIZE = 25;
  const page = $derived(Math.max(1, parseInt(route.query.page ?? "1", 10) || 1));
  // deeper pages are pinned to the height they were opened at, so rows don't shift under you
  let anchor = $state(parseInt(route.query.from ?? "0", 10) || 0);

  // "latest blocks" queries are slow on the API (~2.7 s, frequent 500s); height ranges take ~0.2 s
  const l = loader(async (signal) => {
    const top = anchor || live.tip?.height || 0;
    const hi = top - (page - 1) * SIZE;
    const lo = Math.max(1, hi - SIZE + 1);
    if (hi < 1) return [] as Block[];
    const body = await get(`/blocks?height.from=${lo}&height.to=${hi}&orderBy=height:desc&limit=${SIZE}`, "interactive", signal);
    return body.data as Block[];
  });
  onDestroy(() => l.destroy());

  // reload only when the page changes (not on every new block)
  const hasTip = $derived(!!live.tip);
  $effect(() => {
    if (page > 1 && hasTip) {
      untrack(() => {
        if (!anchor) {
          anchor = live.tip!.height;
          setQuery({ from: anchor });
        }
        l.run();
      });
    }
  });

  const rows = $derived(page === 1 ? live.blocks.slice(0, SIZE) : (l.state.data ?? []));
  const pages = $derived(Math.ceil((anchor || live.tip?.height || 0) / SIZE));

  function goPage(p: number) {
    if (p === 1) {
      anchor = 0;
      setQuery({ page: undefined, from: undefined });
    } else {
      if (!anchor && live.tip) anchor = live.tip.height;
      setQuery({ page: p, from: anchor });
    }
  }
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Blocks</h1>
      <p>{page === 1 ? "Latest, live" : `Below #${formatInt(anchor)}`}</p>
    </div>
  </div>
  <div class="card">
    {#if page > 1 && l.state.error}
      <div class="notice error" style="border:0">{l.state.error}</div>
    {/if}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Height</th>
            <th>Age</th>
            <th>Forged by</th>
            <th class="right"><span class="wide-only">Transactions</span><span class="narrow-only">Txs</span></th>
            <th class="right b-amount">Amount</th>
            <th class="right b-fees">Fees</th>
            <th class="right b-reward">Reward</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as b (b.id)}
            <tr class:flash={page === 1 && b.height === live.tip?.height}>
              <td><a href="#/block/{b.height}">{formatInt(b.height)}</a></td>
              <td class="muted"><span class="wide-only">{ago(b.timestamp.unix, live.now)}</span><span class="narrow-only">{agoShort(b.timestamp.unix, live.now)}</span></td>
              <td><span class="trunc forger" style="--trunc:150px"><Addr address={b.generator.address} /></span></td>
              <td class="right" class:faint={!b.transactions}>{b.transactions}</td>
              <td class="right b-amount">{arkCompact(b.forged.amount)}<Sym /></td>
              <td class="right muted b-fees">{arkCompact(b.forged.fee)}<Sym /></td>
              <td class="right muted b-reward">{arkCompact(b.forged.reward)}<Sym /></td>
            </tr>
          {:else}
            <tr><td colspan="7" class="muted">{l.state.loading || !live.tip ? "Loading…" : "No blocks."}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if live.tip}<Pager {page} {pages} onpage={goPage} />{/if}
  </div>
</div>

<style>
  /* columns drop out least-important first (natural table width ~690px) */
  @media (max-width: 770px) {
    .b-reward {
      display: none;
    }
  }
  @media (max-width: 640px) {
    .b-fees {
      display: none;
    }
  }
  @media (max-width: 520px) {
    .b-amount {
      display: none;
    }
  }
  @media (max-width: 420px) {
    .forger {
      --trunc: 96px !important;
    }
  }
</style>
