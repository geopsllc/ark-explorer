<script lang="ts">
  import { onDestroy } from "svelte";
  import Addr from "../components/Addr.svelte";
  import Amount from "../components/Amount.svelte";
  import Copy from "../components/Copy.svelte";
  import { ApiError, get } from "../lib/api";
  import { attachHeights } from "../lib/heights";
  import { live, onNewBlocks } from "../lib/live.svelte";
  import { loader } from "../lib/loader.svelte";
  import { delegateByPk } from "../lib/delegates.svelte";
  import { ago, formatDate, formatInt } from "../lib/format";
  import { txAmount, txTypeName, txVotes } from "../lib/txinfo";
  import type { Transaction } from "../lib/types";

  let { id }: { id: string } = $props();

  const l = loader(async (signal) => {
    try {
      const t = (await get(`/transactions/${id}`, "interactive", signal)).data as Transaction;
      await attachHeights([t], signal);
      return { tx: t, pending: false };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      // not in a block yet: maybe in the pool
      const t = (await get(`/transactions/unconfirmed/${id}`, "interactive", signal)).data as Transaction;
      return { tx: t, pending: true };
    }
  });
  l.run();
  onDestroy(() => l.destroy());
  // pending -> confirmed
  const off = onNewBlocks((_b, txs) => {
    if (l.state.data?.pending && txs.some((t) => t.id === id)) l.run(true);
  });
  onDestroy(off);

  const t = $derived(l.state.data?.tx);
  const pending = $derived(l.state.data?.pending);
  const confirmations = $derived(t?.height && live.tip ? Math.max(1, live.tip.height - t.height + 1) : (t?.confirmations ?? 0));
  const payments = $derived((t?.asset?.payments ?? []) as { amount: string; recipientId: string }[]);
  const knownAssets = new Set(["payments", "votes"]);
  const otherAsset = $derived(t?.asset ? Object.fromEntries(Object.entries(t.asset).filter(([k]) => !knownAssets.has(k))) : {});
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>{t ? txTypeName(t) : "Transaction"}</h1>
      {#if t}<p>{pending ? "Waiting in the pool for a block" : `Confirmed ${ago(t.timestamp.unix, live.now)}`}</p>{/if}
    </div>
    {#if t}
      {#if pending}<span class="pill warn"><span class="dot pulse"></span>Pending</span>
      {:else}<span class="pill green">{formatInt(confirmations)} confirmations</span>{/if}
    {/if}
  </div>

  {#if l.state.error}
    <div class="notice" class:error={l.state.error !== "Not found"}>{l.state.error === "Not found" ? "No transaction with this ID." : l.state.error}</div>
  {:else if !t}
    <div class="notice">Loading…</div>
  {:else}
    <div class="card">
      <div class="kv">
        <div class="k">ID</div>
        <div class="mono break">{t.id} <Copy text={t.id} /></div>
        {#if !pending}
          <div class="k">Block</div>
          <div>{#if t.height}<a href="#/block/{t.height}">#{formatInt(t.height)}</a>{/if} <a class="mono faint break" href="#/block/{t.blockId}">{t.blockId}</a></div>
          {#if t.timestamp}
            <div class="k">Time</div>
            <div>{formatDate(t.timestamp.unix)} <span class="faint">({ago(t.timestamp.unix, live.now)})</span></div>
          {/if}
        {/if}
        <div class="k">Type</div>
        <div>{txTypeName(t)}</div>
        <div class="k">From</div>
        <div><Addr address={t.sender} full /></div>
        {#if payments.length}
          <div class="k">Recipients</div>
          <div>{payments.length} payments, total <Amount value={txAmount(t)} /></div>
        {:else if t.recipient && !(t.typeGroup === 1 && t.type === 3)}
          <div class="k">To</div>
          <div><Addr address={t.recipient} full /></div>
        {/if}
        {#if t.typeGroup === 1 && t.type === 3}
          <div class="k">Votes</div>
          <div>
            {#each txVotes(t) as v}
              {@const d = delegateByPk(v.publicKey)}
              <span class="pill" class:green={v.sign === "+"} class:red={v.sign === "-"} style="margin-right:6px">
                {v.sign === "+" ? "Vote" : "Unvote"}
                {#if d}<a href="#/wallet/{d.address}">{d.username}</a>{:else}<span class="mono">{v.publicKey}</span>{/if}
              </span>
            {/each}
          </div>
        {/if}
        {#if !payments.length}
          <div class="k">Amount</div>
          <div><Amount value={t.amount} /></div>
        {/if}
        <div class="k">Fee</div>
        <div><Amount value={t.fee} /></div>
        {#if t.vendorField}
          <div class="k">Memo</div>
          <div class="break">{t.vendorField}</div>
        {/if}
        <div class="k">Nonce</div>
        <div>{t.nonce}</div>
        <div class="k">Sender public key</div>
        <div class="mono break faint">{t.senderPublicKey}</div>
        <div class="k">Signature</div>
        <div class="mono break faint">{t.signature}</div>
        {#if t.secondSignature}
          <div class="k">Second signature</div>
          <div class="mono break faint">{t.secondSignature}</div>
        {/if}
        {#if t.signatures?.length}
          <div class="k">Signatures</div>
          <div class="mono break faint">{t.signatures.join("\n")}</div>
        {/if}
        {#if Object.keys(otherAsset).length}
          <div class="k">Asset</div>
          <div><pre class="mono">{JSON.stringify(otherAsset, null, 2)}</pre></div>
        {/if}
      </div>
    </div>

    {#if payments.length}
      <h2 style="margin:24px 0 12px">Payments</h2>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>#</th><th>Recipient</th><th class="right">Amount</th></tr></thead>
          <tbody>
            {#each payments as p, i}
              <tr>
                <td class="faint">{i + 1}</td>
                <td><Addr address={p.recipientId} full /></td>
                <td class="right"><Amount value={p.amount} /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--muted);
  }
</style>
