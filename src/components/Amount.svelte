<script lang="ts">
  import { SYMBOL, TOKEN } from "../lib/site";
  import { formatArk } from "../lib/format";

  let { value, signed = false, decimals = 8 }: { value: string | bigint; signed?: boolean; decimals?: number } = $props();
  const v = $derived(typeof value === "bigint" ? value : BigInt(value || "0"));
</script>

<span class="num" class:green={signed && v > 0n} class:red={signed && v < 0n}
  >{signed && v > 0n ? "+" : ""}{formatArk(v, decimals)} <span class="faint">{SYMBOL}</span></span
>
