import { ApiError, get } from "./api";
import { delegateByName, delegateByPk } from "./delegates.svelte";
import { knownByName } from "./known.svelte";

/** Resolve a search string to a route, or null. */
export async function search(input: string): Promise<string | null> {
  const q = input.trim();
  if (!q) return null;
  // 0x address (validators and wallets); a legacy ARK address (base58) opens its cold wallet
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return `#/wallet/${delegateByPk(q)?.address ?? q}`;
  if (/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(q) && !/^\d+$/.test(q)) return `#/wallet/${q}`;
  if (/^\d+$/.test(q)) return `#/block/${q}`;
  if (/^(0x)?0[23][0-9a-fA-F]{64}$/.test(q)) {
    // a public key: its wallet
    try {
      const body = await get(`/wallets?publicKey=${q.replace(/^0x/, "").toLowerCase()}&limit=1`);
      if (body.data?.[0]?.address) return `#/wallet/${body.data[0].address}`;
    } catch {
      /* not a known key */
    }
    return null;
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(q)) {
    const id = q.replace(/^0x/, "").toLowerCase();
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
  // a username (any wallet can have one), or the directory is still loading: ask the API
  if (/^[a-z0-9_]{1,20}$/i.test(q)) {
    try {
      const body = await get(`/wallets/${encodeURIComponent(q.toLowerCase())}`);
      return `#/wallet/${body.data.address}`;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 422)) return null;
      throw e;
    }
  }
  return null;
}
