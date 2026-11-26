<script lang="ts">
  import { NETWORK, TITLE } from "../lib/site";
  import { live } from "../lib/live.svelte";
  import { route } from "../lib/router.svelte";
  import { formatInt } from "../lib/format";
  import { search } from "../lib/search";
  import { chain } from "../lib/chain";
  import { dir } from "../lib/delegates.svelte";
  import { known, knownLabel } from "../lib/known.svelte";
  import type { Delegate } from "../lib/types";

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

  // ----- validator name suggestions -----
  const MAX_SUGGESTIONS = 8;
  let open = $state(false);
  let sel = $state(-1);
  /** One suggestion: a validator, or one of the protocol's contracts. */
  interface Suggestion {
    name: string;
    address: string;
    meta: string;
    cls: string;
    order: number;
  }
  const status = (d: Delegate) => (d.isResigned ? "resigned" : d.rank > 0 && d.rank <= chain.activeDelegates ? "active" : "standby");
  const suggestions = $derived.by(() => {
    const s = q.trim().toLowerCase();
    // addresses, public keys and IDs are not names
    if (!s || s.length > 20) return [] as Suggestion[];
    const all: Suggestion[] = [
      ...dir.list.map((d) => ({
        name: d.username,
        address: d.address,
        meta: d.isResigned ? "resigned" : `#${d.rank} · ${status(d)}`,
        cls: status(d),
        order: (d.isResigned ? 1e9 : 0) + (d.rank || 1e8),
      })),
      ...known.list.map((k) => ({ name: k.name, address: k.address, meta: knownLabel(k), cls: "known", order: 5e8 })),
    ];
    const exact: Suggestion[] = [];
    const starts: Suggestion[] = [];
    const contains: Suggestion[] = [];
    for (const x of all) {
      const name = x.name.toLowerCase();
      if (name === s) exact.push(x);
      else if (name.startsWith(s)) starts.push(x);
      else if (name.includes(s)) contains.push(x);
    }
    const by = (a: Suggestion, b: Suggestion) => a.order - b.order || a.name.localeCompare(b.name);
    // the exact name first, then names that start with the text, then names that contain it
    return [...exact, ...starts.sort(by), ...contains.sort(by)].slice(0, MAX_SUGGESTIONS);
  });
  const showList = $derived(open && suggestions.length > 0);

  function pick(d: Suggestion) {
    location.hash = `#/wallet/${d.address}`;
    q = "";
    open = false;
    sel = -1;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function keydown(e: KeyboardEvent) {
    if (!showList) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = (sel + 1) % suggestions.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = sel <= 0 ? suggestions.length - 1 : sel - 1;
    } else if (e.key === "Escape") {
      open = false;
      sel = -1;
    } else if (e.key === "Enter" && sel >= 0) {
      e.preventDefault();
      pick(suggestions[sel]);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    open = false;
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
  /** the API answers but no block for over a minute: the chain itself has stopped */
  const stalled = $derived(live.status === "live" && !!live.tip && live.now - live.tip.timestamp.unix * 1000 > 60_000);
  const statusClass = $derived(stalled ? "warn" : live.status === "live" ? "green" : live.status === "connecting" ? "" : live.status === "offline" ? "red" : "warn");
</script>

<header>
  <div class="inner">
    <a class="brand" href="#/">
      <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#E5383B" /><path d="M32 13 50 51H43.5L32 27 20.5 51H14z" fill="#fff" /><path d="M24.5 42.5h15l-2.6-5.3h-9.8z" fill="#fff" /></svg>
      <span>{TITLE}</span><span class="net" title={NETWORK}>testnet</span>
    </a>
    <nav>
      {#each nav as n}
        <a href={n.href} class:on={n.match.includes(page)}>{n.label}</a>
      {/each}
    </nav>
    <form class="search" onsubmit={submit}>
      <input
        class="text"
        placeholder="Address, validator, tx or block ID"
        bind:value={q}
        oninput={() => {
          err = "";
          open = true;
          sel = -1;
        }}
        onfocus={() => (open = true)}
        onblur={() => (open = false)}
        onkeydown={keydown}
        aria-label="Search"
        role="combobox"
        aria-expanded={showList}
        aria-controls="search-suggestions"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
      />
      {#if err}<span class="err">{err}</span>{/if}
      {#if showList}
        <ul class="suggest" id="search-suggestions" role="listbox">
          {#each suggestions as d, i (d.address)}
            <li role="option" aria-selected={i === sel}>
              <!-- mousedown, not click: the input's blur would close the list before a click lands -->
              <button
                type="button"
                class:on={i === sel}
                onmousedown={(e) => {
                  e.preventDefault();
                  pick(d);
                }}
                onmouseenter={() => (sel = i)}
              >
                <span class="sname">{d.name}</span>
                <span class="smeta {d.cls}">{d.meta}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </form>
    <div class="right-side">
      <span class="pill {statusClass}" title={stalled ? "The API answers, but the chain has made no block for over a minute" : live.error || (live.leader ? "This tab polls the API" : "Another tab polls the API and shares updates")}>
        <span class="dot" class:pulse={live.status === "live" && !stalled}></span>
        {stalled ? "Stalled" : statusText[live.status]}
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
  .net {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--warn);
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 1px 4px;
    margin-left: -2px;
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
  .suggest {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--card);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    z-index: 20;
  }
  .suggest button {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .suggest button.on {
    background: var(--accent-soft);
  }
  .sname {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smeta {
    flex: none;
    font-size: 12px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .smeta.active {
    color: var(--green);
  }
  .smeta.known {
    color: var(--accent);
  }
  .smeta.resigned {
    color: var(--red);
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
