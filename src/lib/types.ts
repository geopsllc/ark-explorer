export interface Timestamp {
  epoch: number;
  unix: number;
  human: string;
}

export interface Block {
  id: string;
  version: number;
  height: number;
  previous: string;
  forged: { reward: string; fee: string; amount: string; total: string };
  payload: { hash: string; length: number };
  generator: { username?: string; address: string; publicKey: string };
  signature: string;
  confirmations: number;
  transactions: number;
  timestamp: Timestamp;
}

export interface Transaction {
  id: string;
  blockId: string;
  version: number;
  type: number;
  typeGroup: number;
  amount: string;
  fee: string;
  sender: string;
  senderPublicKey: string;
  recipient?: string;
  signature: string;
  signatures?: string[];
  secondSignature?: string;
  vendorField?: string;
  asset?: any;
  confirmations: number;
  timestamp: Timestamp;
  nonce: string;
  /** derived: tip height at fetch time - confirmations + 1 */
  height?: number;
}

export interface Delegate {
  username: string;
  address: string;
  publicKey: string;
  votes: string;
  rank: number;
  isResigned: boolean;
  blocks: { produced: number; last?: { id: string; height: number; timestamp: Timestamp } };
  production: { approval: number };
  forged: { fees: string; rewards: string; total: string };
}

export interface Wallet {
  address: string;
  publicKey?: string | null;
  balance: string;
  nonce: string;
  attributes: {
    secondPublicKey?: string;
    vote?: string;
    delegate?: {
      username: string;
      voteBalance: string;
      forgedFees: string;
      forgedRewards: string;
      producedBlocks: number;
      rank?: number;
      resigned?: boolean;
      lastBlock?: { height: number; timestamp: number; id: string };
    };
    multiSignature?: { min: number; publicKeys: string[] };
    [k: string]: any;
  };
}

export interface Paged<T> {
  data: T[];
  totalCount: number;
  pageCount: number;
}
