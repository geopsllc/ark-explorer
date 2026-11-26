import { MS_GROUP, MS_TYPE, sameAddress } from "./ms";
import type { Block, Transaction } from "./types";

/** Human name of a transaction type (Core-style types the Mainsail adapter decodes calls into, see ms.ts). */
export function txTypeName(t: Pick<Transaction, "type" | "typeGroup" | "asset">): string {
  if (t.typeGroup === 1) {
    switch (t.type) {
      case 0: return "Transfer";
      case 1: return "Second signature";
      case 2: return "Validator registration";
      case 3: {
        const v: string[] = t.asset?.votes ?? [];
        return v[0]?.startsWith("-") ? "Unvote" : "Vote";
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
  if (t.typeGroup === MS_GROUP) {
    switch (t.type) {
      case MS_TYPE.validatorUpdate: return "Validator update";
      case MS_TYPE.usernameRegistration: return "Username registration";
      case MS_TYPE.usernameResignation: return "Username resignation";
      case MS_TYPE.contractDeployment: return "Contract deployment";
      case MS_TYPE.tokenTransfer: return "Token transfer";
      case MS_TYPE.tokenApproval: return "Token approval";
      default: return "Contract call";
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
  const out = sameAddress(t.sender, me);
  if (t.typeGroup === 1 && t.type === 6) {
    const payments = (t.asset?.payments ?? []) as { amount: string; recipientId: string }[];
    const mine = payments.filter((p) => sameAddress(p.recipientId, me)).reduce((s, p) => s + BigInt(p.amount), 0n);
    if (!out) return mine;
    const sum = payments.reduce((s, p) => s + BigInt(p.amount), 0n);
    return -(sum - mine);
  }
  const amt = BigInt(t.amount ?? "0");
  if (out && sameAddress(t.recipient, me)) return 0n;
  if (out) return -amt;
  return sameAddress(t.recipient, me) ? amt : 0n;
}

/** Vote targets (validator addresses; "" for an unvote, which names nobody) with their sign. */
export function txVotes(t: Transaction): { sign: "+" | "-"; publicKey: string }[] {
  return ((t.asset?.votes ?? []) as string[]).map((v) => ({ sign: v[0] as "+" | "-", publicKey: v.slice(1) }));
}

/** True when the transaction touches `address`. */
export function involves(t: Transaction, address: string): boolean {
  if (sameAddress(t.sender, address) || sameAddress(t.recipient, address) || sameAddress(t.deployedContract, address)) return true;
  if (sameAddress(t.asset?.token?.to, address)) return true;
  return ((t.asset?.payments ?? []) as { recipientId: string }[]).some((p) => sameAddress(p.recipientId, address));
}

/**
 * Transactions read through /blocks/{id}/transactions come without `timestamp` (and with
 * confirmations 0), unlike /transactions. A transaction's time is its block's time, so fill both
 * from the block.
 */
export function inBlock(txs: Transaction[], block: Block): Transaction[] {
  for (const t of txs) {
    t.height = block.height;
    t.timestamp ??= block.timestamp;
  }
  return txs;
}
