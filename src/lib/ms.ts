/**
 * Mainsail adapter: maps the Mainsail REST API's blocks, transactions, wallets and validators onto
 * the shapes the explorer's pages were written for (ARK Core v3's), the same way ARK Wallet does.
 *
 * Differences it smooths over:
 * - amounts stay in wei (18 decimals; format.ts shows them), fees are gasUsed × gasPrice;
 * - blocks have `number` / `hash` / `proposer` (an address) instead of height / id / generator;
 * - transactions are EVM calls: votes, multipayments, validator and username operations are
 *   contract calls, decoded here from the call data into Core-style types and assets;
 * - validators are wallets with validator* attributes; they are keyed by ADDRESS (votes name the
 *   validator's address), so `Delegate.publicKey` holds the address too.
 */
import type { Block, Delegate, Timestamp, Transaction, Wallet } from "./types";

export const CONSENSUS = "0x535B3D7A252fa034Ed71F0C53ec0C6F784cB64E1";
export const MULTIPAYMENT = "0x00EFd0D4639191C49908A7BddbB9A11A994A8527";
export const USERNAMES = "0x2c1DE3b4Dbb4aDebEbB5dcECAe825bE2a9fc6eb6";

const SEL = {
  vote: "6dd7d8ea",
  unvote: "3174b689",
  pay: "084ce708",
  register: "226f2645",
  registerLegacy: "602a9eee",
  update: "8f062626",
  updateLegacy: "5a8eed73",
  resign: "b85f5da2",
  username: "36a94134",
  usernameResign: "ebed6dab",
  erc20Transfer: "a9059cbb",
  erc20Approve: "095ea7b3",
};

/** Mainsail-only kinds, in a typeGroup of their own (see txinfo.ts). */
export const MS_GROUP = 100;
export const MS_TYPE = {
  validatorUpdate: 1,
  usernameRegistration: 2,
  usernameResignation: 3,
  contractCall: 4,
  contractDeployment: 5,
  tokenTransfer: 6,
  tokenApproval: 7,
};

export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function timestamp(ms: number | string | undefined | null): Timestamp {
  const n = Number(ms ?? 0);
  return { epoch: 0, unix: n / 1000, human: n ? new Date(n).toISOString() : "" };
}

// ---------- blocks ----------

export function mapBlock(b: any): Block {
  const reward = String(b.reward ?? "0");
  const fee = String(b.fee ?? "0");
  return {
    id: b.hash,
    version: b.version ?? 1,
    height: Number(b.number),
    previous: b.parentHash ?? "",
    forged: { reward, fee, amount: "0", total: String(b.total ?? BigInt(reward) + BigInt(fee)) },
    payload: { hash: b.transactionsRoot ?? "", length: b.payloadSize ?? 0 },
    generator: { username: b.username || undefined, address: checksum(b.proposer ?? ""), publicKey: b.publicKey ?? "" },
    signature: b.signature ?? "",
    confirmations: b.confirmations ?? 0,
    transactions: b.transactionsCount ?? 0,
    timestamp: timestamp(b.timestamp),
    round: Number(b.round ?? 0),
    gasUsed: Number(b.gasUsed ?? 0),
    validatorSet: b.validatorSet,
  };
}

// ---------- transactions ----------

const word = (d: string, i: number) => d.slice(8 + i * 64, 8 + (i + 1) * 64);
const wordAt = (d: string, byteOffset: number) => d.slice(8 + byteOffset * 2, 8 + byteOffset * 2 + 64);
const num = (w: string) => (w ? BigInt("0x" + w) : 0n);
const addr = (w: string) => checksum("0x" + w.slice(24));

/** Byte length (after the selector) of the ABI-encoded dynamic array whose offset is word `offsetWord`. */
function arrayEnd(d: string, offsetWord: number): number {
  const off = Number(num(word(d, offsetWord)));
  return off + 32 + Number(num(wordAt(d, off))) * 32;
}

function decodeArray(d: string, offsetWord: number): string[] {
  const off = Number(num(word(d, offsetWord)));
  const len = Number(num(wordAt(d, off)));
  const out: string[] = [];
  for (let k = 0; k < len && k < 1000; k++) out.push(wordAt(d, off + 32 + k * 32));
  return out;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeString(d: string): string {
  try {
    const off = Number(num(word(d, 0)));
    const len = Number(num(wordAt(d, off)));
    return new TextDecoder("utf-8", { fatal: true }).decode(hexBytes(d.slice(8 + (off + 32) * 2, 8 + (off + 32 + len) * 2)));
  } catch {
    return "";
  }
}

/** A transfer's data read as a text memo, when it is printable UTF-8. */
function memoText(hex: string): string | undefined {
  if (!hex || hex.length % 2) return undefined;
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(hexBytes(hex));
    return /^[^\u0000-\u0008\u000e-\u001f\u007f]*$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

export function mapTx(t: any): Transaction {
  const data = String(t.data ?? "").replace(/^0x/, "").toLowerCase();
  const to: string = t.to ? checksum(t.to) : "";
  const sel = data.slice(0, 8);
  const failed = t.receipt ? Number(t.receipt.status) === 0 : false;
  const gasUsed = Number(t.receipt?.gasUsed ?? t.gas ?? 0);
  const tx: Transaction = {
    id: t.hash,
    blockId: t.blockHash ?? "",
    version: 0,
    type: 0,
    typeGroup: 1,
    amount: String(t.value ?? "0"),
    fee: (BigInt(gasUsed) * BigInt(t.gasPrice ?? 0)).toString(),
    sender: checksum(t.from ?? ""),
    senderPublicKey: t.senderPublicKey ?? "",
    recipient: to || undefined,
    signature: t.signature ?? "",
    confirmations: t.confirmations ?? 0,
    timestamp: t.timestamp ? timestamp(t.timestamp) : (undefined as unknown as Timestamp),
    nonce: String(t.nonce ?? ""),
    data,
    gas: String(t.gas ?? ""),
    gasPrice: String(t.gasPrice ?? "0"),
    gasUsed,
    failed,
    error: t.receipt?.decodedError || undefined,
    deployedContract: t.receipt?.deployedContractAddress ? checksum(t.receipt.deployedContractAddress) : undefined,
    legacySecondSignature: t.legacySecondSignature || undefined,
  };
  const set = (typeGroup: number, type: number, asset?: any) => Object.assign(tx, { typeGroup, type, asset });
  if (!to) {
    set(MS_GROUP, MS_TYPE.contractDeployment);
  } else if (sameAddress(to, CONSENSUS)) {
    if (sel === SEL.vote) set(1, 3, { votes: ["+" + addr(word(data, 0))] });
    else if (sel === SEL.unvote) set(1, 3, { votes: ["-"] });
    else if (sel === SEL.register || sel === SEL.registerLegacy) set(1, 2);
    else if (sel === SEL.update || sel === SEL.updateLegacy) set(MS_GROUP, MS_TYPE.validatorUpdate);
    else if (sel === SEL.resign) set(1, 7);
    else set(MS_GROUP, MS_TYPE.contractCall);
  } else if (sameAddress(to, MULTIPAYMENT) && sel === SEL.pay) {
    const recipients = decodeArray(data, 0).map(addr);
    const amounts = decodeArray(data, 1).map((w) => num(w).toString());
    set(1, 6, { payments: failed ? [] : recipients.map((r, i) => ({ recipientId: r, amount: amounts[i] ?? "0" })) });
    // a memo appended after pay()'s arguments (the contract ignores extra bytes; ark-tbw payouts
    // carry one, once per multipayment)
    const end = 8 + Math.max(64, arrayEnd(data, 0), arrayEnd(data, 1)) * 2;
    if (data.length > end) {
      const memo = memoText(data.slice(end));
      if (memo) tx.vendorField = memo;
    }
  } else if (sameAddress(to, USERNAMES)) {
    if (sel === SEL.username) set(MS_GROUP, MS_TYPE.usernameRegistration, { username: decodeString(data) });
    else if (sel === SEL.usernameResign) set(MS_GROUP, MS_TYPE.usernameResignation);
    else set(MS_GROUP, MS_TYPE.contractCall);
  } else if (data) {
    const memo = memoText(data);
    if (memo !== undefined) tx.vendorField = memo;
    else if (sel === SEL.erc20Transfer && data.length >= 8 + 128) set(MS_GROUP, MS_TYPE.tokenTransfer, { token: { to: addr(word(data, 0)), value: num(word(data, 1)).toString() } });
    else if (sel === SEL.erc20Approve && data.length >= 8 + 128) set(MS_GROUP, MS_TYPE.tokenApproval, { token: { spender: addr(word(data, 0)), value: num(word(data, 1)).toString() } });
    else set(MS_GROUP, MS_TYPE.contractCall);
  }
  // a reverted call moved nothing
  if (failed) tx.amount = "0";
  return tx;
}

// ---------- wallets and validators ----------

const isValidatorAttrs = (a: any) => "validatorPublicKey" in a || "validatorRank" in a || "validatorResigned" in a;

export function mapWallet(w: any): Wallet {
  const a = w.attributes ?? {};
  const out: Wallet = {
    address: checksum(w.address),
    publicKey: w.publicKey || null,
    balance: String(w.balance ?? "0"),
    nonce: String(w.nonce ?? "0"),
    attributes: { ...a, vote: a.vote ? checksum(a.vote) : undefined },
  };
  if (isValidatorAttrs(a)) {
    out.attributes.delegate = {
      username: a.username || "",
      voteBalance: String(a.validatorVoteBalance ?? "0"),
      forgedFees: String(a.validatorForgedFees ?? "0"),
      forgedRewards: String(a.validatorForgedRewards ?? "0"),
      producedBlocks: a.validatorProducedBlocks ?? 0,
      rank: a.validatorRank,
      resigned: !!a.validatorResigned,
      lastBlock: a.validatorLastBlock
        ? { height: Number(a.validatorLastBlock.number), timestamp: Number(a.validatorLastBlock.timestamp), id: a.validatorLastBlock.hash }
        : undefined,
    };
  }
  return out;
}

/** Display name for a validator without a registered username. */
export const unnamed = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function mapValidator(v: any): Delegate {
  const a = v.attributes ?? {};
  const address = checksum(v.address);
  const last = a.validatorLastBlock;
  return {
    username: a.username || unnamed(address),
    address,
    publicKey: address,
    votes: String(a.validatorVoteBalance ?? "0"),
    rank: a.validatorRank ?? 0,
    isResigned: !!a.validatorResigned,
    blocks: {
      produced: a.validatorProducedBlocks ?? 0,
      last: last ? { id: last.hash, height: Number(last.number), timestamp: timestamp(last.timestamp) } : undefined,
    },
    production: { approval: typeof a.validatorApproval === "number" ? a.validatorApproval * 100 : 0 },
    forged: {
      fees: String(a.validatorForgedFees ?? "0"),
      rewards: String(a.validatorForgedRewards ?? "0"),
      total: String(a.validatorForgedTotal ?? "0"),
    },
    voters: a.validatorVotersCount,
    blsPublicKey: a.validatorPublicKey || undefined,
  };
}

// ---------- EIP-55 checksum (keccak-256) ----------

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number) => (n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64 : x);

function keccakF(s: bigint[]) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + ((2 * x + 3 * y) % 5) * 5] = rotl(s[x + y * 5], ROT[x + y * 5]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & M64 & b[((x + 2) % 5) + y]);
    s[0] ^= RC[round];
  }
}

/** keccak-256 of short input (one block: up to 135 bytes, enough for an address). */
export function keccak256(msg: Uint8Array): Uint8Array {
  const rate = 136;
  if (msg.length >= rate) throw new Error("input too long");
  const block = new Uint8Array(rate);
  block.set(msg);
  block[msg.length] ^= 0x01;
  block[rate - 1] ^= 0x80;
  const s = new Array<bigint>(25).fill(0n);
  for (let i = 0; i < rate / 8; i++) {
    let lane = 0n;
    for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(block[i * 8 + k]);
    s[i] = lane;
  }
  keccakF(s);
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((s[i] >> BigInt(8 * k)) & 0xffn);
  return out;
}

const checksummed = new Map<string, string>();
/** EIP-55 form of a 0x address (other strings are returned unchanged). */
export function checksum(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address;
  const lower = address.slice(2).toLowerCase();
  const hit = checksummed.get(lower);
  if (hit) return hit;
  const hash = keccak256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  if (checksummed.size > 5000) checksummed.clear();
  checksummed.set(lower, out);
  return out;
}
