<script lang="ts">
  import { knownLabel, knownWallet } from "../lib/known.svelte";
  import { mapTx, mapWallet, sameAddress } from "../lib/ms";
  import Sym from "../components/Sym.svelte";
  import { onDestroy, untrack } from "svelte";
  import Addr from "../components/Addr.svelte";
  import Amount from "../components/Amount.svelte";
  import Copy from "../components/Copy.svelte";
  import Pager from "../components/Pager.svelte";
  import TxTable from "../components/TxTable.svelte";
  import { ApiError, get, pagedNewestFirst } from "../lib/api";
  import { attachHeights } from "../lib/heights";
  import { chain } from "../lib/chain";
  import { live, onNewBlocks } from "../lib/live.svelte";
  import { loader } from "../lib/loader.svelte";
  import { delegateByPk, forgingHealth, missed, missedCount, missedSinceLastBlock } from "../lib/delegates.svelte";
  import { route, setQuery } from "../lib/router.svelte";
  import { ago, arkCompact, formatInt } from "../lib/format";
  import { involves } from "../lib/txinfo";
  import type { Transaction, Wallet } from "../lib/types";

  let { id }: { id: string } = $props();

  type Tab = "all" | "sent" | "received" | "voters";
  const SIZE = 25;
  const tab = $derived((route.query.tab as Tab) || "all");
  const page = $derived(Math.max(1, parseInt(route.query.page ?? "1", 10) || 1));

  // ----- wallet -----
  type Cold = { cold?: boolean; legacy?: { mergedInto?: string; mergeTx?: string } };
  const LEGACY = /^[1-9A-HJ-NP-Za-km-z]{25,35}$/;
  const w = loader(async (signal) => {
    // an ARK Core address (base58) is a legacy cold wallet: its balance waits for its first transaction
    if (LEGACY.test(id) && !/^0x/.test(id) && !/^\d+$/.test(id)) {
      const c = (await get(`/legacy/cold-wallets/${encodeURIComponent(id)}`, "interactive", signal)).data;
      return {
        address: c.address, balance: String(c.balance ?? "0"), nonce: String(c.attributes?.legacyNonce ?? "0"), attributes: {}, publicKey: null, cold: true,
        legacy: { mergedInto: c.mergeInfoWalletAddress ?? undefined, mergeTx: c.mergeInfoTransactionHash ?? undefined },
      } as Wallet & Cold;
    }
    try {
      return mapWallet((await get(`/wallets/${encodeURIComponent(id)}`, "interactive", signal)).data) as Wallet & Cold;
    } catch (e) {
      // a valid address that never received anything is "not found" by the API
      if (e instanceof ApiError && e.status === 404 && /^0x[0-9a-fA-F]{40}$/.test(id)) {
        return { address: id, balance: "0", nonce: "0", attributes: {}, publicKey: null } as Wallet & Cold;
      }
      throw e;
    }
  });
  untrack(() => w.run());

  const wallet = $derived(w.state.data);
  /** an exchange or ARK team wallet from the public known-wallets list */
  const kw = $derived(knownWallet(wallet?.address ?? id));
  // a plain address needs no lookup first: its transactions load alongside the wallet
  const address = $derived(wallet?.address ?? (/^0x[0-9a-fA-F]{40}$/.test(id) ? id : ""));
  const cold = $derived(!!wallet?.cold);
  const del = $derived(wallet?.attributes?.delegate);
  const delegate = $derived(wallet ? delegateByPk(wallet.address) : undefined);
  const votedFor = $derived(wallet?.attributes?.vote ? delegateByPk(wallet.attributes.vote) : undefined);
  // the API accepts usernames and any letter case too: show the canonical address in the URL
  $effect(() => {
    if (wallet && id !== wallet.address) history.replaceState(null, "", `#/wallet/${wallet.address}` + (location.hash.includes("?") ? "?" + location.hash.split("?")[1] : ""));
  });

  // ----- transactions / voters -----
  let totals = $state<Record<string, number>>({});
  const list = loader(async (signal) => {
    if (!address || cold) return { txs: [] as Transaction[], voters: [] as Wallet[] };
    if (tab === "voters") {
      const body = await get(`/validators/${address}/voters?page=${page}&limit=${SIZE}&orderBy=balance:desc`, "interactive", signal);
      totals.voters = body.meta?.totalCount ?? 0;
      return { txs: [] as Transaction[], voters: (body.data as any[]).map(mapWallet) };
    }
    const suffix = tab === "all" ? "" : `/${tab}`;
    const r = await pagedNewestFirst<any>(`/wallets/${address}/transactions${suffix}`, page, SIZE, totals[tab] ?? 0, signal);
    totals[tab] = r.totalCount;
    return { txs: await attachHeights(r.data.map(mapTx), signal), voters: [] as Wallet[] };
  });
  $effect(() => {
    void tab;
    void page;
    void cold;
    if (address) untrack(() => list.run());
  });
  onDestroy(() => {
    w.destroy();
    list.destroy();
  });

  // every tab's count up front (one limit=1 request each), not just the tabs that were opened
  const countsAbort = new AbortController();
  onDestroy(() => countsAbort.abort());
  async function loadCounts() {
    if (!address) return;
    if (cold) {
      totals = { all: 0, sent: 0, received: 0 };
      return;
    }
    const want: [string, string][] = [
      ["all", `/wallets/${address}/transactions?limit=1`],
      ["sent", `/wallets/${address}/transactions/sent?limit=1`],
      ["received", `/wallets/${address}/transactions/received?limit=1`],
    ];
    if (del) want.push(["voters", `/validators/${address}/voters?limit=1`]);
    await Promise.all(
      want.map(async ([k, path]) => {
        try {
          const body = await get(path, "background", countsAbort.signal);
          if (typeof body.meta?.totalCount === "number") totals[k] = body.meta.totalCount;
        } catch {
          /* the count shows up when the tab is opened */
        }
      }),
    );
  }
  $effect(() => {
    void address;
    void cold;
    void del;
    untrack(() => loadCounts());
  });

  // live: refresh when a new block touches this wallet (or it forged one)
  const off = onNewBlocks((blocks, txs) => {
    if (!address) return;
    const forged = blocks.some((b) => sameAddress(b.generator.address, address));
    if (forged || txs.some((t) => involves(t, address))) {
      w.run(true);
      if (page === 1 && tab !== "voters") list.run(true);
      loadCounts();
    }
  });
  onDestroy(off);

  const pages = $derived(Math.max(1, Math.ceil((totals[tab] ?? 0) / SIZE)));
  const isActive = $derived(!!delegate && !delegate.isResigned && delegate.rank > 0 && delegate.rank <= chain.activeDelegates);
  const healthMissed = $derived(delegate ? (void missed.lastMissed, missedSinceLastBlock(delegate)) : 0);
  const healthState = $derived(delegate ? (void missed.lastMissed, forgingHealth(delegate)) : "forging");
  const tabs = $derived([
    { key: "all", label: "Transactions" },
    { key: "sent", label: "Sent" },
    { key: "received", label: "Received" },
    ...(del ? [{ key: "voters", label: "Voters" }] : []),
  ]);
</script>

<div class="page">
  <div class="page-head">
    <div style="min-width:0">
      <h1>{del?.username || wallet?.attributes?.username || kw?.name || (cold ? "Legacy wallet" : "Wallet")}</h1>
      <p class="mono break">{wallet?.address ?? id} {#if wallet}<Copy text={wallet.address} />{/if}</p>
    </div>
    {#if del}
      <div>
        {#if del.resigned || delegate?.isResigned}<span class="pill red">Resigned validator</span>
        {:else if isActive}
          <span class="pill green">Active validator · rank {delegate?.rank}</span>
        {:else}<span class="pill">Standby validator · rank {delegate?.rank ?? del.rank ?? "–"}</span>{/if}
      </div>
    {:else if kw}
      <div><span class="pill accent" title="One of the protocol's own contracts">{knownLabel(kw)}</span></div>
    {:else if cold}
      <div><span class="pill" title="An ARK Core address carried over from the snapshot: it becomes a 0x account with its first transaction">Legacy cold wallet</span></div>
    {/if}
  </div>

  {#if w.state.error}
    <div class="notice" class:error={w.state.error !== "Not found"}>{w.state.error === "Not found" ? "No wallet or validator found." : w.state.error}</div>
  {:else if !wallet}
    <div class="notice">Loading…</div>
  {:else}
    <div class="stats">
      <div class="stat">
        <div class="label">Balance</div>
        <div class="value">{arkCompact(wallet.balance)}<Sym /></div>
        <div class="sub"><Amount value={wallet.balance} /></div>
      </div>
      <div class="stat">
        <div class="label">Voting for</div>
        <div class="value">
          {#if votedFor}<a href="#/wallet/{votedFor.address}">{votedFor.username}</a>
          {:else if wallet.attributes?.vote}<span class="mono">{wallet.attributes.vote.slice(0, 10)}…</span>
          {:else}<span class="faint">nobody</span>{/if}
        </div>
        {#if votedFor}<div class="sub">rank {votedFor.rank}</div>{/if}
      </div>
      {#if del}
        <div class="stat">
          <div class="label">Votes received</div>
          <div class="value">{arkCompact(del.voteBalance)}<Sym /></div>
          <div class="sub">
            {delegate ? `${delegate.production.approval.toFixed(2)}% · ` : ""}{delegate?.voters !== undefined
              ? `${formatInt(delegate.voters)} voters`
              : totals.voters
                ? `${formatInt(totals.voters)} voters`
                : ""}
          </div>
        </div>
        <div class="stat">
          <div class="label">Blocks produced</div>
          <div class="value">{formatInt(delegate?.blocks.produced ?? del.producedBlocks)}</div>
          <div class="sub">
            {#if delegate?.blocks.last}last <a href="#/block/{delegate.blocks.last.height}">{ago(delegate.blocks.last.timestamp.unix, live.now)}</a>{/if}
          </div>
        </div>
        <div class="stat">
          <div class="label">Forged</div>
          <div class="value">{arkCompact(BigInt(del.forgedRewards) + BigInt(del.forgedFees))}<Sym /></div>
          <div class="sub">{arkCompact(del.forgedFees)}<Sym /> in fees</div>
        </div>
        {#if isActive}
          <div class="stat">
            <div class="label">Missed ({missed.windowHours} h)</div>
            <div class="value" class:warn={missedCount(wallet.address) > 0}>{missedCount(wallet.address)}</div>
            <div class="sub">
              {#if healthState === "unknown"}<span class="faint">checking recent blocks…</span>{:else if healthState === "forging"}<span class="green">forging</span>{:else if healthState === "missed"}<span class="warn">missed {healthMissed > 1 ? `last ${healthMissed} turns` : "last turn"}</span>{:else}<span class="red">dead</span> <span class="faint">({healthMissed} missed turns in a row)</span>{/if}
              {#if !missed.ready} · scanning {Math.round(missed.progress * 100)}%{/if}
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="kv">
        <div class="k">Address</div>
        <div class="mono break">{wallet.address}</div>
        {#if cold}
          <div class="k">Status</div>
          <div>
            {#if wallet.legacy?.mergedInto}merged into <Addr address={wallet.legacy.mergedInto} full />{#if wallet.legacy.mergeTx} by <a class="mono" href="#/transaction/{wallet.legacy.mergeTx}">{wallet.legacy.mergeTx.slice(0, 12)}…</a>{/if}
            {:else}not claimed yet: the balance moves to a 0x account with the key's first Mainsail transaction{/if}
          </div>
        {:else}
          <div class="k">Public key</div>
          <div class="mono break">{wallet.publicKey ?? "not revealed yet (no outgoing transactions)"}</div>
          {#if wallet.attributes?.username}
            <div class="k">Username</div>
            <div>{wallet.attributes.username}</div>
          {/if}
          {#if delegate?.blsPublicKey || wallet.attributes?.validatorPublicKey}
            <div class="k">Validator key (BLS)</div>
            <div class="mono break faint">{delegate?.blsPublicKey ?? wallet.attributes.validatorPublicKey}</div>
          {/if}
        {/if}
        <div class="k">Nonce</div>
        <div>{wallet.nonce}</div>
        {#if !cold}
          <div class="k">Second signature</div>
          <div>{wallet.attributes?.secondPublicKey ? "Yes (legacy, from ARK Core)" : "No"}</div>
        {/if}
        {#if wallet.attributes?.isLegacy}
          <div class="k">Origin</div>
          <div>ARK Core wallet carried over from the snapshot</div>
        {/if}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="seg">
          {#each tabs as t}
            <button class:on={tab === t.key} onclick={() => setQuery({ tab: t.key === "all" ? undefined : t.key, page: undefined })}>
              {t.label}{#if totals[t.key] !== undefined}<span class="count faint hide-xs">{formatInt(totals[t.key])}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      {#if list.state.error}
        <div class="notice error" style="border:0">{list.state.error}</div>
      {:else if list.state.loading && !list.state.data}
        <div class="notice" style="border:0">Loading…</div>
      {:else if tab === "voters"}
        <div class="table-wrap">
          <table>
            <thead><tr><th>Voter</th><th class="right">Balance</th><th class="right"><span class="wide-only">Share of votes</span><span class="narrow-only" title="Share of votes">%</span></th></tr></thead>
            <tbody>
              {#each list.state.data?.voters ?? [] as v (v.address)}
                <tr>
                  <td><Addr address={v.address} full /></td>
                  <td class="right"><Amount value={v.balance} decimals={2} /></td>
                  <td class="right muted">{del && BigInt(del.voteBalance) > 0n ? ((Number(BigInt(v.balance) * 10000n / BigInt(del.voteBalance)) / 100).toFixed(2) + "%") : ""}</td>
                </tr>
              {:else}
                <tr><td colspan="3" class="muted">No voters.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <TxTable txs={list.state.data?.txs ?? []} me={wallet.address} />
      {/if}
      {#if (totals[tab] ?? 0) > SIZE}<Pager {page} {pages} onpage={(p) => setQuery({ page: p === 1 ? undefined : p })} />{/if}
    </div>
  {/if}
</div>
