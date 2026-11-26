// ARK Mainsail testnet only, always through the official public API.

export const TITLE = "ARK Mainsail Explorer";
export const NETWORK = "Mainsail testnet";
export const PRIMARY_API = "https://testnet.mainsailhq.com/api";
/** The transaction pool API (unconfirmed transactions live here, not in the main API). */
export const POOL_API = "https://testnet.mainsailhq.com/tx/api";
/** Currency name shown after amounts (the testnet token; the API calls it "ARK", symbol "TѦ"). */
export const SYMBOL = "TARK";
export const TOKEN = "TARK";
/** Requests per minute one browser may send (the API allows 200 per IP per minute). */
export const REQUEST_BUDGET = 170;
/** How far back missed blocks are counted. */
export const MISSED_WINDOW_HOURS = 24;
/** localStorage key prefix */
export const STORE = "ark-explorer:mainsail-testnet";
