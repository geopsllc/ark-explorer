<script lang="ts">
  import Addr from "./Addr.svelte";
  import { live } from "../lib/live.svelte";
  import { delegateByPk } from "../lib/delegates.svelte";
  import { ago, arkCompact, formatInt, shortAddress } from "../lib/format";
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
        <th>Age</th>
        <th>Type</th>
        <th>From</th>
        <th>To</th>
        <th class="right">Amount</th>
        <th class="right">Fee</th>
        {#if showBlock}<th class="right">Block</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each txs as t (t.id)}
        {@const rec = recipients(t)}
        {@const amt = me ? txAmountFor(t, me) : txAmount(t)}
        <tr class:flash={flashNew && t.height === live.tip?.height}>
          <td><a class="mono" href="#/transaction/{t.id}" title={t.id}>{shortAddress(t.id, 6)}</a></td>
          <td class="muted">{ago(t.timestamp.unix, live.now)}</td>
          <td>
            {txTypeName(t)}
            {#if t.typeGroup === 1 && t.type === 3}
              {#each txVotes(t) as v}
                <span class="vote" class:red={v.sign === "-"} class:green={v.sign === "+"}>{v.sign}{delegateByPk(v.publicKey)?.username ?? shortAddress(v.publicKey, 4)}</span>
              {/each}
            {/if}
          </td>
          <td><Addr address={t.sender} self={me} /></td>
          <td>
            {#if rec.length > 1}
              <span class="muted">{rec.length} recipients</span>
            {:else if rec.length === 1}
              <Addr address={rec[0]} self={me} />
            {:else}<span class="faint">–</span>{/if}
          </td>
          <td class="right" class:green={me && amt > 0n} class:red={me && amt < 0n}>
            {#if amt === 0n}<span class="faint">0</span>{:else}{me && amt > 0n ? "+" : ""}{me && amt < 0n ? "-" : ""}{arkCompact(amt < 0n ? -amt : amt)}{/if}
          </td>
          <td class="right muted">{arkCompact(t.fee)}</td>
          {#if showBlock}
            <td class="right">{#if t.height}<a href="#/block/{t.height}">{formatInt(t.height)}</a>{:else}<a href="#/block/{t.blockId}">view</a>{/if}</td>
          {/if}
        </tr>
      {:else}
        <tr><td colspan="8" class="muted">No transactions.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .vote {
    margin-left: 6px;
    font-size: 12px;
  }
</style>
