<script lang="ts">
  import Sym from "./Sym.svelte";
  import { formatArk } from "../lib/format";

  let { value, signed = false, decimals = 8 }: { value: string | bigint; signed?: boolean; decimals?: number } = $props();
  const v = $derived(typeof value === "bigint" ? value : BigInt(value || "0"));
  // wei dust that rounds to zero at `decimals` shows in full instead
  const text = $derived.by(() => {
    const t = formatArk(v, decimals);
    return v !== 0n && /^-?[0.]+$/.test(t) ? formatArk(v, 18, 0) : t;
  });
</script>

<span class="num" class:green={signed && v > 0n} class:red={signed && v < 0n}
  >{signed && v > 0n ? "+" : ""}{text}<Sym /></span
>
