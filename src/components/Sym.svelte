<script lang="ts">
  import { SYMBOL, TOKEN } from "../lib/site";
</script>

<!-- The currency name (TARK on the testnet) in ARK red, a little smaller than the number it follows. -->
<span class="sym" title={TOKEN}>{SYMBOL}</span>

<style>
  .sym {
    font-size: 0.78em;
    font-weight: inherit;
    letter-spacing: 0.02em;
    color: var(--brand);
    /* the only gap between a number and its glyph: the same everywhere and scales with the type */
    margin-left: 0.3em;
  }
</style>
