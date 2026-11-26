<script lang="ts">
  import { onDestroy } from "svelte";
  import Addr from "../components/Addr.svelte";
  import Amount from "../components/Amount.svelte";
  import Copy from "../components/Copy.svelte";
  import TxTable from "../components/TxTable.svelte";
  import { ApiError, get } from "../lib/api";
  import { live } from "../lib/live.svelte";
  import { loader } from "../lib/loader.svelte";
  import { formatDate, formatInt, ago } from "../lib/format";
  import { inBlock } from "../lib/txinfo";
  import { roundOf, roundOrder } from "../lib/chain";
  import { mapBlock, mapTx } from "../lib/ms";
  import { missedBefore } from "../lib/roundview";
  import type { Transaction } from "../lib/types";

  let { id }: { id: string } = $props();

  const l = loader(async (signal) => {
    const block = mapBlock((await get(`/blocks/${id}`, "interactive", signal)).data);
    let txs: Transaction[] = [];
    // who missed before this block: the proposers of its earlier consensus rounds
    const missedBy = block.round ? roundOrder(roundOf(block.height)).then((list) => missedBefore(list, { height: block.height, id: block.id, proposer: block.generator.address, round: block.round })).catch(() => [] as string[]) : Promise.resolve([] as string[]);
    if (block.transactions) {
      for (let page = 1; page <= 3 && txs.length < block.transactions; page++) {
        const body = await get(`/blocks/${block.id}/transactions?page=${page}&limit=100`, "interactive", signal);
        txs.push(...(body.data as any[]).map(mapTx));
        if (body.data.length < 100) break;
      }
      inBlock(txs, block);
    }
    return { block, txs, missedBy: await missedBy };
  });
  l.run();
  onDestroy(() => l.destroy());

  // a block that is not forged yet: wait for it
  $effect(() => {
    if (/^\d+$/.test(id) && l.state.error === "Not found" && live.tip && live.tip.height >= Number(id)) l.run();
  });

  const b = $derived(l.state.data?.block);
  /** validators that signed the commit (bits of the validatorSet mask) */
  const signers = $derived.by(() => {
    try {
      let v = BigInt(b?.validatorSet ?? "0"), c = 0;
      for (; v > 0n; v >>= 1n) c += Number(v & 1n);
      return c;
    } catch {
      return 0;
    }
  });
  const confirmations = $derived(b && live.tip ? Math.max(1, live.tip.height - b.height + 1) : b?.confirmations);
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Block {b ? `#${formatInt(b.height)}` : ""}</h1>
      {#if b}<p>Forged {ago(b.timestamp.unix, live.now)} by <Addr address={b.generator.address} /></p>{/if}
    </div>
    {#if b}
      <div class="nav">
        <a class="btn" href="#/block/{b.height - 1}">‹ Previous</a>
        {#if live.tip && b.height < live.tip.height}<a class="btn" href="#/block/{b.height + 1}">Next ›</a>{/if}
      </div>
    {/if}
  </div>

  {#if l.state.error}
    <div class="notice" class:error={l.state.error !== "Not found"}>
      {#if l.state.error === "Not found"}
        {#if /^\d+$/.test(id) && live.head && Number(id) <= live.head.height}
          Block #{formatInt(Number(id))} was just produced. The API has its details a few seconds after the
          next block; this page will update then.
        {:else if /^\d+$/.test(id) && live.tip && Number(id) > live.tip.height}
          Block #{formatInt(Number(id))} has not been produced yet. This page will update when it is.
        {:else}No block with this ID or height.{/if}
      {:else}{l.state.error}{/if}
    </div>
  {:else if !b}
    <div class="notice">Loading…</div>
  {:else}
    <div class="card">
      <div class="kv">
        <div class="k">ID</div>
        <div class="mono break">{b.id} <Copy text={b.id} /></div>
        <div class="k">Height</div>
        <div>{formatInt(b.height)}</div>
        <div class="k">Time</div>
        <div>{formatDate(b.timestamp.unix)} <span class="faint">({ago(b.timestamp.unix, live.now)})</span></div>
        <div class="k">Confirmations</div>
        <div>{formatInt(confirmations)}</div>
        <div class="k">Forged by</div>
        <div><Addr address={b.generator.address} full /></div>
        <div class="k">Transactions</div>
        <div>{b.transactions}</div>
        <div class="k">Consensus round</div>
        <div>
          {b.round}
          {#if b.round > 0}<span class="warn"> · {b.round === 1 ? "1 proposer" : `${b.round} proposers`} missed first</span>{/if}
        </div>
        {#if l.state.data?.missedBy.length}
          <div class="k">Missed by</div>
          <div>{#each l.state.data.missedBy as a, i}{#if i}, {/if}<Addr address={a} />{/each}</div>
        {/if}
        {#if signers}
          <div class="k">Signed by</div>
          <div>{signers} validators</div>
        {/if}
        <div class="k">Gas used</div>
        <div>{formatInt(b.gasUsed)}</div>
        <div class="k">Fees</div>
        <div><Amount value={b.forged.fee} /></div>
        <div class="k">Reward</div>
        <div><Amount value={b.forged.reward} /></div>
        <div class="k">Previous block</div>
        <div class="mono break"><a href="#/block/{b.previous}">{b.previous}</a></div>
        <div class="k">Payload</div>
        <div class="mono break faint">{b.payload.length} bytes · transactions root {b.payload.hash}</div>
        <div class="k">Signature</div>
        <div class="mono break faint">{b.signature}</div>
      </div>
    </div>
    {#if l.state.data && l.state.data.txs.length}
      <h2 style="margin:24px 0 12px">Transactions</h2>
      <div class="card"><TxTable txs={l.state.data.txs} showBlock={false} /></div>
    {/if}
  {/if}
</div>

<style>
  .nav {
    display: flex;
    gap: 8px;
  }
  .nav a:hover {
    text-decoration: none;
  }
</style>
