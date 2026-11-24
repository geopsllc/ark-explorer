<script lang="ts">
  import { onMount } from "svelte";
  import Header from "./components/Header.svelte";
  import Delegates from "./pages/Delegates.svelte";
  import Blocks from "./pages/Blocks.svelte";
  import BlockPage from "./pages/Block.svelte";
  import Transactions from "./pages/Transactions.svelte";
  import TransactionPage from "./pages/Transaction.svelte";
  import WalletPage from "./pages/Wallet.svelte";
  import Wallets from "./pages/Wallets.svelte";
  import Shares from "./pages/Shares.svelte";
  import { PRIMARY_API, TITLE } from "./lib/site";
  import { live, startLive } from "./lib/live.svelte";
  import { startDirectory, startMissedScan } from "./lib/delegates.svelte";
  import { startKnown } from "./lib/known.svelte";
  import { route, startRouter } from "./lib/router.svelte";

  let ready = $state(false);

  onMount(() => {
    startRouter();
    ready = true;
    startDirectory();
    startKnown();
    startLive();
  });

  // the missed-block scan needs the tip; start it once the first blocks are in
  let scanStarted = false;
  $effect(() => {
    if (live.tip && !scanStarted) {
      scanStarted = true;
      setTimeout(() => startMissedScan(), 1500);
    }
  });

  // ArkScan-style names for detail pages (/transactions/<id>, /addresses/<address>) work too
  const ALIAS: Record<string, string> = { transactions: "transaction", addresses: "wallet", address: "wallet", wallets: "wallet", blocks: "block" };
  const page = $derived(route.parts[1] && ALIAS[route.parts[0]] ? ALIAS[route.parts[0]] : (route.parts[0] ?? ""));
</script>

<Header />
{#if live.status === "offline" && !live.tip}
  <div class="page"><div class="notice error">Could not reach the ARK API ({PRIMARY_API}): {live.error}. Retrying…</div></div>
{:else if ready}
  {#key route.parts.join("/")}
    {#if page === "" || page === "validators" || page === "delegates"}
      <Delegates />
    {:else if page === "blocks"}
      <Blocks />
    {:else if page === "block" && route.parts[1]}
      <BlockPage id={route.parts[1]} />
    {:else if page === "transactions"}
      <Transactions />
    {:else if page === "transaction" && route.parts[1]}
      <TransactionPage id={route.parts[1]} />
    {:else if page === "shares"}
      <Shares />
    {:else if page === "wallets"}
      <Wallets />
    {:else if page === "wallet" && route.parts[1]}
      <WalletPage id={route.parts[1]} />
    {:else}
      <div class="page"><div class="notice">Page not found. <a href="#/">Go to validators</a></div></div>
    {/if}
  {/key}
{/if}
<footer>
  {TITLE} · open source · not affiliated with ARK · data from
  <span class="mono">{PRIMARY_API.replace(/^https?:\/\//, "")}</span>
</footer>

<style>
  footer {
    text-align: center;
    color: var(--faint);
    font-size: 12px;
    padding: 20px 12px 30px;
  }
</style>
