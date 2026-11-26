import { get } from "./api";
import { live } from "./live.svelte";
import type { Transaction } from "./types";

const known = new Map<string, number>(); // blockId -> height (immutable)

/**
 * Fill in `height` for transactions. The API only gives the block hash and a confirmations count
 * that depends on its own (unknown) tip, so heights are looked up exactly: blocks we already have
 * are free, the rest cost one request per page (`/blocks?hash=a,b,c`).
 */
export async function attachHeights(txs: Transaction[], signal?: AbortSignal) {
  for (const b of live.blocks) known.set(b.id, b.height);
  const missing = [...new Set(txs.filter((t) => !known.has(t.blockId)).map((t) => t.blockId))];
  if (missing.length) {
    try {
      for (let i = 0; i < missing.length; i += 50) {
        const ids = missing.slice(i, i + 50);
        const body = await get(`/blocks?hash=${ids.join(",")}&limit=100`, "interactive", signal);
        for (const b of body.data as any[]) known.set(b.hash, Number(b.number));
      }
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      /* heights are a nicety: rows still link to the block by ID */
    }
  }
  for (const t of txs) {
    const h = known.get(t.blockId);
    if (h) t.height = h;
  }
  return txs;
}
