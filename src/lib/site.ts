// ARK Mainsail testnet only, always through the official public API.

export const TITLE = "Mainsail Explorer";
export const NETWORK = "Mainsail testnet";
export const PRIMARY_API = "https://testnet.mainsailhq.com/api";
/** The transaction pool API (unconfirmed transactions live here, not in the main API). */
export const POOL_API = "https://testnet.mainsailhq.com/tx/api";
/** Currency name shown after amounts (the testnet token; the API calls it "ARK", symbol "TѦ"). */
export const SYMBOL = "TARK";
export const TOKEN = "TARK";
/** The node's JSON-RPC endpoint: sees a new block ~8 s before the REST API does (see live.svelte.ts). */
export const RPC_API = "https://testnet.mainsailhq.com/rpc/api";
/**
 * REST requests per minute one browser may send. The testnet REST API enforces no limit
 * (measured Nov 2026: 1,000+ requests a minute were all answered), so this only keeps us polite.
 */
export const REQUEST_BUDGET = 600;
/** JSON-RPC requests per minute (the RPC endpoint allows 150 per IP per 60 s window). */
export const RPC_BUDGET = 120;
/** How far back missed blocks are counted. */
export const MISSED_WINDOW_HOURS = 24;
/** localStorage key prefix */
export const STORE = "ark-explorer:mainsail-testnet";
