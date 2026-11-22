import { get } from "./api";
import { live } from "./live.svelte";
import type { Block, Transaction } from "./types";

const known = new Map<string, number>(); // blockId -> height (immutable)

/**
 * Fill in `height` for transactions. The API only gives blockId and a confirmations count that
 * depends on its own (unknown) tip, so heights are looked up exactly: blocks we already have are
 * free, the rest cost one request per page (`/blocks?id=a,b,c` answers 25 IDs in ~0.2 s).
 */
export async function attachHeights(txs: Transaction[], signal?: AbortSignal) {
  for (const b of live.blocks) known.set(b.id, b.height);
  const missing = [...new Set(txs.filter((t) => !known.has(t.blockId)).map((t) => t.blockId))];
  if (missing.length) {
    try {
      for (let i = 0; i < missing.length; i += 50) {
        const ids = missing.slice(i, i + 50);
        const body = await get(`/blocks?id=${ids.join(",")}&limit=100`, "interactive", signal);
        for (const b of body.data as Block[]) known.set(b.id, b.height);
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
