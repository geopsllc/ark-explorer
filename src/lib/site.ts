// ARK mainnet only, always through the official public API.

export const TITLE = "ARK Explorer";
export const PRIMARY_API = "https://api.ark.io/api";
export const SYMBOL = "Ѧ";
export const TOKEN = "ARK";
/** Requests per minute one browser may send (api.ark.io allows 200 per IP per minute). */
export const REQUEST_BUDGET = 170;
/** How far back missed blocks are counted. */
export const MISSED_WINDOW_HOURS = 24;
/** localStorage key prefix */
export const STORE = "ark-explorer:mainnet";
