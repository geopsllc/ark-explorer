<script lang="ts">
  import Addr from "./Addr.svelte";
  import { live } from "../lib/live.svelte";
  import { delegateByPk } from "../lib/delegates.svelte";
  import { ago, agoShort, arkCompact, formatInt, shortAddress } from "../lib/format";
  import { txAmount, txAmountFor, txTypeName, txVotes } from "../lib/txinfo";
  import type { Transaction } from "../lib/types";

  let { txs, me = "", showBlock = true, flashNew = false }: { txs: Transaction[]; me?: string; showBlock?: boolean; flashNew?: boolean } = $props();

  function recipients(t: Transaction): string[] {
    if (t.typeGroup === 1 && t.type === 6) return (t.asset?.payments ?? []).map((p: any) => p.recipientId);
    return t.recipient ? [t.recipient] : [];
  }
</script>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th class="t-age">Age</th>
        <th class="t-type">Type</th>
        <th class="t-from">From</th>
        <th class="t-to">To</th>
        <th class="right">Amount</th>
        <th class="right t-fee">Fee</th>
        {#if showBlock}<th class="right t-block">Block</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each txs as t (t.id)}
        {@const rec = recipients(t)}
        {@const amt = me ? txAmountFor(t, me) : txAmount(t)}
        <tr class:flash={flashNew && t.height === live.tip?.height}>
          <td class="nowrap"><a class="mono" href="#/transaction/{t.id}" title={t.id}><span class="id-long">{shortAddress(t.id, 6)}</span><span class="id-short">{shortAddress(t.id, 4)}</span></a><span class="t-typeinline faint"> · {txTypeName(t)}</span></td>
          <td class="muted t-age">{#if t.timestamp}<span class="wide-only">{ago(t.timestamp.unix, live.now)}</span><span class="narrow-only">{agoShort(t.timestamp.unix, live.now)}</span>{:else}<span class="faint">–</span>{/if}</td>
          <td class="t-type">
            <span class="trunc" style="--trunc:230px">{txTypeName(t)}
            {#if t.typeGroup === 1 && t.type === 3}
              {#each txVotes(t) as v}
                <span class="vote" class:red={v.sign === "-"} class:green={v.sign === "+"}>{v.sign}{delegateByPk(v.publicKey)?.username ?? shortAddress(v.publicKey, 4)}</span>
              {/each}
            {/if}</span>
          </td>
          <td class="t-from"><span class="trunc" style="--trunc:150px"><Addr address={t.sender} self={me} /></span></td>
          <td class="t-to"><span class="trunc" style="--trunc:150px">
            {#if rec.length > 1}
              <span class="muted">{rec.length} recipients</span>
            {:else if rec.length === 1}
              <Addr address={rec[0]} self={me} />
            {:else}<span class="faint">–</span>{/if}
          </span></td>
          <td class="right" class:green={me && amt > 0n} class:red={me && amt < 0n}>
            {#if amt === 0n}<span class="faint">0</span>{:else}{me && amt > 0n ? "+" : ""}{me && amt < 0n ? "-" : ""}{arkCompact(amt < 0n ? -amt : amt)}{/if}
          </td>
          <td class="right muted t-fee">{arkCompact(t.fee)}</td>
          {#if showBlock}
            <td class="right t-block">{#if t.height}<a href="#/block/{t.height}">{formatInt(t.height)}</a>{:else}<a href="#/block/{t.blockId}">view</a>{/if}</td>
          {/if}
        </tr>
      {:else}
        <tr><td colspan="8" class="muted">No transactions.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  /* columns drop out least-important first (natural table width ~880px) */
  .t-typeinline,
  .id-short {
    display: none;
  }
  @media (max-width: 430px) {
    .id-long {
      display: none;
    }
    .id-short {
      display: inline;
    }
  }
  @media (max-width: 930px) {
    .t-block {
      display: none;
    }
  }
  @media (max-width: 840px) {
    .t-fee {
      display: none;
    }
  }
  @media (max-width: 740px) {
    .t-from {
      display: none;
    }
  }
  @media (max-width: 620px) {
    .t-to {
      display: none;
    }
  }
  @media (max-width: 500px) {
    .t-type {
      display: none;
    }
    .t-typeinline {
      display: inline;
    }
  }
  @media (max-width: 380px) {
    .t-age {
      display: none;
    }
  }

  .vote {
    margin-left: 6px;
    font-size: 12px;
  }
</style>
