/**
 * Named addresses that are not validators. On Mainsail these are the protocol's own contracts
 * (votes, multipayments and usernames are calls to them); ARK's known-wallets list only covers
 * Core mainnet addresses, so there is nothing to fetch.
 */
import { CONSENSUS, MULTIPAYMENT, USERNAMES } from "./ms";

export type KnownType = "exchange" | "team" | "contract";
export interface KnownWallet {
  address: string;
  name: string;
  type: KnownType;
}

export const known = $state({
  list: [
    { address: CONSENSUS, name: "Consensus contract", type: "contract" },
    { address: MULTIPAYMENT, name: "Multipayment contract", type: "contract" },
    { address: USERNAMES, name: "Usernames contract", type: "contract" },
  ] as KnownWallet[],
});
const byAddress = new Map(known.list.map((k) => [k.address.toLowerCase(), k]));

/** The known wallet at `address`, if any (any letter case). */
export function knownWallet(address: string | undefined | null): KnownWallet | undefined {
  return address ? byAddress.get(address.toLowerCase()) : undefined;
}

export function knownByName(name: string): KnownWallet | undefined {
  const n = name.trim().toLowerCase();
  return known.list.find((k) => k.name.toLowerCase() === n);
}

/** Kept for App.svelte: nothing to load on Mainsail. */
export function startKnown() {}

/** Label for a known wallet's kind. */
export const knownLabel = (k: KnownWallet) => (k.type === "team" ? "ARK team" : k.type === "contract" ? "contract" : "exchange");
