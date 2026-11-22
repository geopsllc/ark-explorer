<script lang="ts">
  import { SYMBOL, TOKEN } from "../lib/site";
</script>

<!-- The ARK currency glyph (Ѧ) in ARK red, sized to the number it follows (same as ARK Wallet). -->
<span class="sym" title={TOKEN}>{SYMBOL}</span>

<style>
  .sym {
    font-size: 1em;
    font-weight: inherit;
    color: var(--brand);
    /* the only gap between a number and its glyph: the same everywhere and scales with the type */
    margin-left: 0.2em;
  }
</style>
