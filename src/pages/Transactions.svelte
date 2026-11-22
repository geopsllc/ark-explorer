<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import Pager from "../components/Pager.svelte";
  import TxTable from "../components/TxTable.svelte";
  import { pagedNewestFirst } from "../lib/api";
  import { attachHeights } from "../lib/heights";
  import { live, onNewBlocks } from "../lib/live.svelte";
  import { loader } from "../lib/loader.svelte";
  import { route, setQuery } from "../lib/router.svelte";
  import { formatInt } from "../lib/format";
  import type { Transaction } from "../lib/types";

  const SIZE = 25;
  const page = $derived(Math.max(1, parseInt(route.query.page ?? "1", 10) || 1));
  let total = $state(0);

  const l = loader(async (signal) => {
    const r = await pagedNewestFirst<Transaction>("/transactions", page, SIZE, total, signal);
    total = r.totalCount;
    return attachHeights(r.data, signal);
  });
  onDestroy(() => l.destroy());
  $effect(() => {
    void page;
    untrack(() => l.run());
  });

  // page 1 stays live: new transactions from new blocks are added on top
  let rows = $state<Transaction[]>([]);
  $effect(() => {
    rows = l.state.data ?? [];
  });
  const off = onNewBlocks((_b, txs) => {
    if (page !== 1 || !txs.length || !l.state.data) return;
    const seen = new Set(rows.map((t) => t.id));
    const add = txs.filter((t) => !seen.has(t.id));
    total += add.length;
    rows = [...add, ...rows].slice(0, SIZE);
  });
  onDestroy(off);

  const pages = $derived(Math.max(1, Math.ceil(total / SIZE)));
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Transactions</h1>
      <p>{total ? `${formatInt(total)} transactions` : ""}{page === 1 ? " · newest first, updated live" : ""}</p>
    </div>
  </div>
  <div class="card">
    {#if l.state.error}
      <div class="notice error" style="border:0">{l.state.error}</div>
    {:else if l.state.loading && !rows.length}
      <div class="notice" style="border:0">Loading…</div>
    {/if}
    {#if rows.length}<TxTable txs={rows} flashNew={page === 1} />{/if}
    {#if total}<Pager {page} {pages} onpage={(p) => setQuery({ page: p === 1 ? undefined : p })} />{/if}
  </div>
</div>
