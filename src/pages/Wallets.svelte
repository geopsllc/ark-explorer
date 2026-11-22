<script lang="ts">
  import Sym from "../components/Sym.svelte";
  import { onDestroy, untrack } from "svelte";
  import Addr from "../components/Addr.svelte";
  import Amount from "../components/Amount.svelte";
  import Pager from "../components/Pager.svelte";
  import { get } from "../lib/api";
  import { delegateByPk } from "../lib/delegates.svelte";
  import { formatInt } from "../lib/format";
  import { loader } from "../lib/loader.svelte";
  import { route, setQuery } from "../lib/router.svelte";
  import type { Wallet } from "../lib/types";

  // The API's balance-ordered wallet list is fast at any depth once dust is filtered out
  // (≥1 ARK: ~34k wallets, page 900 in ~1.3 s); unfiltered it has ~207k rows and deep pages time out.
  const SIZE = 25;
  const MIN_BALANCE = 100_000_000; // 1 ARK
  const page = $derived(Math.max(1, parseInt(route.query.page ?? "1", 10) || 1));
  let total = $state(0);
  let supply = $state(0n);

  const l = loader(async (signal) => {
    const [body, chain] = await Promise.all([
      get(`/wallets?balance.from=${MIN_BALANCE}&orderBy=balance:desc&page=${page}&limit=${SIZE}`, "interactive", signal),
      supply ? null : get("/blockchain", "interactive", signal).catch(() => null),
    ]);
    total = body.meta?.totalCount ?? 0;
    if (chain?.data?.supply) supply = BigInt(chain.data.supply);
    return body.data as Wallet[];
  });
  onDestroy(() => l.destroy());
  $effect(() => {
    void page;
    untrack(() => l.run());
  });

  const pages = $derived(Math.max(1, Math.ceil(total / SIZE)));
  const share = (balance: string) => (supply > 0n ? Number((BigInt(balance) * 1_000_000n) / supply) / 10_000 : 0);
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Wallets</h1>
      <p>{#if total}{formatInt(total)} wallets holding at least 1<Sym /> · largest first{/if}</p>
    </div>
  </div>
  <div class="card">
    {#if l.state.error}
      <div class="notice error" style="border:0">{l.state.error}</div>
    {:else if l.state.loading && !l.state.data}
      <div class="notice" style="border:0">Loading…</div>
    {/if}
    {#if l.state.data?.length}
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th class="right" title="Rank by balance">#</th>
              <th>Wallet</th>
              <th class="right">Balance</th>
              <th class="right w-share" title="Share of the total supply">%</th>
              <th class="w-vote">Voting for</th>
            </tr>
          </thead>
          <tbody>
            {#each l.state.data as w, i (w.address)}
              {@const voted = delegateByPk(w.attributes?.vote)}
              <tr>
                <td class="right faint num">{formatInt((page - 1) * SIZE + i + 1)}</td>
                <td><span class="trunc w-addr" style="--trunc:330px"><Addr address={w.address} full /></span></td>
                <td class="right"><Amount value={w.balance} decimals={0} /></td>
                <td class="right muted num w-share">{share(w.balance).toFixed(2)}%</td>
                <td class="w-vote">
                  {#if voted}<a href="#/wallet/{voted.address}" class="trunc" style="--trunc:150px">{voted.username}</a>
                  {:else if w.attributes?.vote}<a href="#/wallet/{w.attributes.vote}" class="mono">{w.attributes.vote.slice(0, 10)}…</a>
                  {:else}<span class="faint">–</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if total}<Pager {page} {pages} onpage={(p) => setQuery({ page: p === 1 ? undefined : p })} />{/if}
  </div>
</div>

<style>
  @media (max-width: 899px) {
    .w-addr {
      --trunc: 150px !important;
    }
  }
  @media (max-width: 559px) {
    .w-vote {
      display: none;
    }
  }
  @media (max-width: 379px) {
    .w-share {
      display: none;
    }
  }
</style>
