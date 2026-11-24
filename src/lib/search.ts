import { ApiError, get } from "./api";
import { delegateByName, delegateByPk } from "./delegates.svelte";
import { knownByName } from "./known.svelte";

/** Resolve a search string to a route, or null. */
export async function search(input: string): Promise<string | null> {
  const q = input.trim();
  if (!q) return null;
  // hidden page: reward sharing (no delegate is registered under this name)
  if (q.toLowerCase() === "shares") return "#/shares";
  if (/^[A-Za-z0-9]{34}$/.test(q)) return `#/wallet/${q}`;
  if (/^0[23][0-9a-fA-F]{64}$/.test(q)) {
    const d = delegateByPk(q.toLowerCase());
    return `#/wallet/${d?.address ?? q.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{64}$/.test(q)) {
    const id = q.toLowerCase();
    try {
      await get(`/transactions/${id}`);
      return `#/transaction/${id}`;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    try {
      await get(`/blocks/${id}`);
      return `#/block/${id}`;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    return null;
  }
  const d = delegateByName(q);
  if (d) return `#/wallet/${d.address}`;
  const k = knownByName(q);
  if (k) return `#/wallet/${k.address}`;
  // directory may still be loading: ask the API
  try {
    const body = await get(`/delegates/${encodeURIComponent(q.toLowerCase())}`);
    return `#/wallet/${body.data.address}`;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 422)) return null;
    throw e;
  }
}
