<script lang="ts">
  let { page, pages, onpage }: { page: number; pages: number; onpage: (p: number) => void } = $props();
  let jump = $state("");
</script>

<div class="pager">
  <button class="btn" disabled={page <= 1} onclick={() => onpage(1)}>First</button>
  <button class="btn" disabled={page <= 1} onclick={() => onpage(page - 1)}>Prev</button>
  <span class="muted num">Page {page.toLocaleString("en-US")}{pages ? ` of ${pages.toLocaleString("en-US")}` : ""}</span>
  <button class="btn" disabled={pages > 0 && page >= pages} onclick={() => onpage(page + 1)}>Next</button>
  {#if pages > 0}<button class="btn" disabled={page >= pages} onclick={() => onpage(pages)}>Last</button>{/if}
  <form
    onsubmit={(e) => {
      e.preventDefault();
      const n = parseInt(jump, 10);
      if (n >= 1 && (!pages || n <= pages)) onpage(n);
      jump = "";
    }}
  >
    <input class="text" size="6" placeholder="Page" bind:value={jump} aria-label="Go to page" />
  </form>
</div>

<style>
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    flex-wrap: wrap;
    border-top: 1px solid var(--border);
  }
  input {
    width: 72px;
    padding: 6px 8px;
  }
</style>
