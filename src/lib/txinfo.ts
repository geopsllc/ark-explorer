import type { Transaction } from "./types";

/** Human name of a transaction type (Core v3 type groups 1 and 2). */
export function txTypeName(t: Pick<Transaction, "type" | "typeGroup" | "asset">): string {
  if (t.typeGroup === 1) {
    switch (t.type) {
      case 0: return "Transfer";
      case 1: return "Second signature";
      case 2: return "Validator registration";
      case 3: {
        const v: string[] = t.asset?.votes ?? [];
        return v.length === 2 ? "Vote switch" : v[0]?.startsWith("-") ? "Unvote" : "Vote";
      }
      case 4: return "Multisignature";
      case 5: return "IPFS";
      case 6: return "Multipayment";
      case 7: return "Validator resignation";
      case 8: return "HTLC lock";
      case 9: return "HTLC claim";
      case 10: return "HTLC refund";
    }
  }
  if (t.typeGroup === 2) {
    return ["Business registration", "Business resignation", "Business update", "Bridgechain registration", "Bridgechain resignation", "Bridgechain update", "Entity"][t.type] ?? `Magistrate ${t.type}`;
  }
  return `Type ${t.typeGroup}/${t.type}`;
}

/** Total moved by a transaction, in arktoshi (multipayments: sum of payments). */
export function txAmount(t: Transaction): bigint {
  if (t.typeGroup === 1 && t.type === 6) {
    return ((t.asset?.payments ?? []) as { amount: string }[]).reduce((s, p) => s + BigInt(p.amount), 0n);
  }
  return BigInt(t.amount ?? "0");
}

/** Signed amount from the point of view of `me` (wallet pages). */
export function txAmountFor(t: Transaction, me: string): bigint {
  const out = t.sender === me;
  if (t.typeGroup === 1 && t.type === 6) {
    const payments = (t.asset?.payments ?? []) as { amount: string; recipientId: string }[];
    const mine = payments.filter((p) => p.recipientId === me).reduce((s, p) => s + BigInt(p.amount), 0n);
    if (!out) return mine;
    const sum = payments.reduce((s, p) => s + BigInt(p.amount), 0n);
    return -(sum - mine);
  }
  const amt = BigInt(t.amount ?? "0");
  if (out && t.recipient === me) return 0n;
  if (out) return -amt;
  return t.recipient === me ? amt : 0n;
}

/** Vote targets (public keys) with their sign. */
export function txVotes(t: Transaction): { sign: "+" | "-"; publicKey: string }[] {
  return ((t.asset?.votes ?? []) as string[]).map((v) => ({ sign: v[0] as "+" | "-", publicKey: v.slice(1) }));
}

/** True when the transaction touches `address`. */
export function involves(t: Transaction, address: string): boolean {
  if (t.sender === address || t.recipient === address) return true;
  return ((t.asset?.payments ?? []) as { recipientId: string }[]).some((p) => p.recipientId === address);
}
