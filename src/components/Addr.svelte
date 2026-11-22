<script lang="ts">
  import { nameOf } from "../lib/delegates.svelte";
  import { shortAddress } from "../lib/format";

  let { address, full = false, self = "" }: { address: string | undefined | null; full?: boolean; self?: string } = $props();
  const name = $derived(nameOf(address));
</script>

{#if !address}
  <span class="faint">–</span>
{:else if address === self}
  <span class="muted" title={address}>{name ?? (full ? address : shortAddress(address, 6))}</span>
{:else if full && !name}
  <!-- full address on wide screens, shortened on phones -->
  <a href="#/wallet/{address}" title={address} class="mono"><span class="wide-only">{address}</span><span class="narrow-only">{shortAddress(address, 6)}</span></a>
{:else}
  <a href="#/wallet/{address}" title={address} class:mono={!name}>{name ?? shortAddress(address, 6)}</a>
{/if}
