<script lang="ts">
  let { text }: { text: string } = $props();
  let done = $state(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    done = true;
    setTimeout(() => (done = false), 1200);
  }
</script>

<button class="copy" title="Copy" onclick={copy} aria-label="Copy">
  {#if done}
    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" /></svg>
  {:else}
    <svg viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
  {/if}
</button>

<style>
  .copy {
    border: 0;
    background: transparent;
    color: var(--faint);
    cursor: pointer;
    padding: 2px 4px;
    vertical-align: middle;
  }
  .copy:hover {
    color: var(--accent);
  }
</style>
