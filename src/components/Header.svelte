<script lang="ts">
  import { TITLE } from "../lib/site";
  import { live } from "../lib/live.svelte";
  import { route } from "../lib/router.svelte";
  import { formatInt } from "../lib/format";
  import { search } from "../lib/search";

  let q = $state("");
  let busy = $state(false);
  let err = $state("");

  const page = $derived(route.parts[0] ?? "");
  const nav = [
    { href: "#/", label: "Validators", match: ["", "validators", "delegates"] },
    { href: "#/blocks", label: "Blocks", match: ["blocks", "block"] },
    { href: "#/transactions", label: "Transactions", match: ["transactions", "transaction"] },
    { href: "#/wallets", label: "Wallets", match: ["wallets", "wallet"] },
  ];

  async function submit(e: Event) {
    e.preventDefault();
    if (!q.trim() || busy) return;
    busy = true;
    err = "";
    try {
      const target = await search(q);
      if (target) {
        location.hash = target;
        q = "";
      } else err = "Nothing found";
    } catch (e: any) {
      err = e?.message ?? "Search failed";
    } finally {
      busy = false;
    }
  }

  const statusText: Record<string, string> = {
    connecting: "Connecting",
    live: "Live",
    delayed: "Delayed",
    offline: "Offline",
    "rate-limited": "Rate limited",
  };
  const statusClass = $derived(live.status === "live" ? "green" : live.status === "connecting" ? "" : live.status === "offline" ? "red" : "warn");
</script>

<header>
  <div class="inner">
    <a class="brand" href="#/">
      <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#E5383B" /><path d="M32 13 50 51H43.5L32 27 20.5 51H14z" fill="#fff" /><path d="M24.5 42.5h15l-2.6-5.3h-9.8z" fill="#fff" /></svg>
      <span>{TITLE}</span>
    </a>
    <nav>
      {#each nav as n}
        <a href={n.href} class:on={n.match.includes(page)}>{n.label}</a>
      {/each}
    </nav>
    <form class="search" onsubmit={submit}>
      <input
        class="text"
        placeholder="Address, validator, tx/block ID or height"
        bind:value={q}
        oninput={() => (err = "")}
        aria-label="Search"
      />
      {#if err}<span class="err">{err}</span>{/if}
    </form>
    <div class="right-side">
      <span class="pill {statusClass}" title={live.error || (live.leader ? "This tab polls the API" : "Another tab polls the API and shares updates")}>
        <span class="dot" class:pulse={live.status === "live"}></span>
        {statusText[live.status]}
        {#if live.tip}<a class="height" href="#/block/{live.tip.height}">#{formatInt(live.tip.height)}</a>{/if}
      </span>
    </div>
  </div>
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(24, 24, 27, 0.88);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .inner {
    max-width: 1280px;
    margin: 0 auto;
    padding: 10px 20px;
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text);
    font-weight: 600;
    font-size: 15px;
  }
  .brand:hover {
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 4px;
  }
  nav a {
    color: var(--muted);
    padding: 6px 11px;
    border-radius: 8px;
  }
  nav a:hover {
    color: var(--text);
    text-decoration: none;
    background: rgba(255, 255, 255, 0.05);
  }
  nav a.on {
    color: var(--text);
    background: var(--card-hover);
  }
  .search {
    flex: 1;
    min-width: 220px;
    position: relative;
  }
  .search input {
    width: 100%;
  }
  .err {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 12px;
    color: var(--red);
  }
  .right-side {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .height {
    color: inherit;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 800px) {
    .inner {
      padding: 10px 12px;
      gap: 10px;
    }
    .search {
      order: 10;
      flex-basis: 100%;
    }
  }
  @media (max-width: 420px) {
    nav {
      gap: 0;
    }
    nav a {
      padding: 6px 8px;
    }
  }
</style>
