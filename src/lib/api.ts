/**
 * Every API request goes through here. Timeouts, retries and pacing were first tuned on api.ark.io
 * (ARK Core); the limits below were re-measured on the Mainsail testnet (November 2026):
 *
 * - REST (testnet.mainsailhq.com/api): no limit is enforced. It sends x-ratelimit-limit: 200,
 *   but the remaining count never goes down and 1,000+ requests a minute were all answered.
 *   We still keep a budget (REQUEST_BUDGET, 600/min) so one browser stays polite.
 * - JSON-RPC (/rpc/api): 150 requests per fixed 60 s window per IP, then 429 until the window
 *   ends. Only the tip watcher uses it (~20-30 requests/min); its budget is RPC_BUDGET (120).
 * - Requests are counted in a sliding 60 s window per host and each priority stops at its own
 *   share of that host's budget. After a 429 the host is paused (REST: probed every 10 s).
 * - Block lists are always read by number range (/blocks?number.from=&number.to=): cheap and
 *   exact, also for the live poller.
 * - Deep newest-first pages are read oldest-first and reversed (see `pagedNewestFirst`).
 *
 * Priorities:
 * - interactive (what the user is looking at): 10 s timeout, 500 retried after 0.3 s and 1 s,
 *   network errors after 0.5 s and 1.5 s, 4xx never.
 * - live (block poller, tip watcher): 3 s timeout, no retries: the next poll is seconds away.
 * - background (directory): 8 s timeout, no retries; paused when the budget runs low.
 * - bulk (the 24 h missed-turn scan): like background but with a smaller share, so a first
 *   visit's scan cannot hold up the pages on screen.
 */
import { PRIMARY_API, REQUEST_BUDGET, RPC_API, RPC_BUDGET } from "./site";

export type Priority = "interactive" | "live" | "background" | "bulk";

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export class RateLimitError extends ApiError {
  constructor(public seconds: number) {
    super(`The API rate limit was reached. Retrying in ${Math.max(1, Math.ceil(seconds))}s…`, 429);
  }
}

const TIMEOUT: Record<Priority, number> = { interactive: 10_000, live: 3_000, background: 8_000, bulk: 8_000 };
const RETRY: Record<Priority, { server: number[]; network: number[] }> = {
  interactive: { server: [300, 1000], network: [500, 1500] },
  live: { server: [], network: [] },
  background: { server: [], network: [] },
  bulk: { server: [], network: [] },
};
/** Share of the per-minute budget each priority may use (the rest stays free for higher ones). */
const SHARE: Record<Priority, number> = { interactive: 1, live: 0.9, background: 0.75, bulk: 0.35 };
/** Longest wait for budget that is absorbed silently instead of reported. */
const MAX_SILENT_WAIT_MS = 3000;
const WINDOW_MS = 60_000;
const PROBE_MS = 10_000;
/** After an RPC 429: its window is 60 s long and started at most 60 s ago. */
const RPC_PAUSE_MS = 20_000;

/** One rate-limited host. */
interface Bucket {
  budget: number;
  started: number[]; // request start times inside the window
  pausedUntil: number; // after a 429: no requests before this (except the REST probe)
}
const rest: Bucket = { budget: REQUEST_BUDGET, started: [], pausedUntil: 0 };
const rpcBucket: Bucket = { budget: RPC_BUDGET, started: [], pausedUntil: 0 };
let probing = false;

export const stats = { requests: 0, rpcRequests: 0, last429: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds until `priority` may start a request on `b` (0 = now). */
function budgetWait(b: Bucket, priority: Priority, now: number): number {
  while (b.started.length && now - b.started[0] >= WINDOW_MS) b.started.shift();
  if (now < b.pausedUntil) return b.pausedUntil - now;
  const limit = Math.floor(b.budget * SHARE[priority]);
  if (b.started.length < limit) return 0;
  return b.started[b.started.length - limit] + WINDOW_MS - now + 5;
}

async function acquire(b: Bucket, priority: Priority) {
  for (;;) {
    const wait = budgetWait(b, priority, Date.now());
    if (wait === 0) break;
    if (priority === "interactive" && wait > MAX_SILENT_WAIT_MS) throw new RateLimitError(wait / 1000);
    if (priority === "live" && wait > 1000) throw new RateLimitError(wait / 1000); // the poller retries on its own schedule
    await sleep(Math.min(wait, 1000));
  }
  b.started.push(Date.now());
}

/** After a REST 429 nothing is sent until a cheap probe gets through (every 10 s). */
function startProbe() {
  if (probing) return;
  probing = true;
  rest.pausedUntil = Date.now() + PROBE_MS;
  (async () => {
    for (;;) {
      await sleep(Math.max(0, rest.pausedUntil - Date.now()));
      try {
        const res = await fetch(PRIMARY_API + "/blockchain", { cache: "no-store" });
        if (res.status !== 429) break;
      } catch {
        /* network trouble: keep probing */
      }
      rest.pausedUntil = Date.now() + PROBE_MS;
    }
    rest.pausedUntil = 0;
    probing = false;
  })();
}

/** fetch with the priority's timeout, tied to the caller's abort signal */
async function timedFetch(url: string, init: RequestInit, priority: Priority, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT[priority]);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } catch (e: any) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new ApiError(ctrl.signal.aborted ? "The API did not answer in time" : "Network error");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

let rpcId = 0;
/**
 * One JSON-RPC call (eth_* methods of the node), on its own budget. No retries: only the tip
 * watcher uses it, and it falls back to the REST poller while RPC fails.
 */
export async function rpc(method: string, params: unknown[] = [], priority: Priority = "live", signal?: AbortSignal): Promise<any> {
  await acquire(rpcBucket, priority);
  stats.rpcRequests++;
  const res = await timedFetch(
    RPC_API,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) },
    priority,
    signal,
  );
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (res.status === 429 || body?.statusCode === 429) {
    rpcBucket.pausedUntil = Date.now() + RPC_PAUSE_MS;
    throw new RateLimitError(RPC_PAUSE_MS / 1000);
  }
  if (!res.ok || !body) throw new ApiError(`RPC error ${res.status}`, res.status);
  if (body.error) throw new ApiError(`RPC error: ${body.error.message ?? body.error.code}`, 400);
  return body.result;
}

async function once(path: string, priority: Priority, signal?: AbortSignal): Promise<any> {
  await acquire(rest, priority);
  stats.requests++;
  const res = await timedFetch(/^https?:/.test(path) ? path : PRIMARY_API + path, {}, priority, signal);
  if (res.status === 429) {
    stats.last429 = Date.now();
    startProbe();
    throw new RateLimitError(PROBE_MS / 1000);
  }
  if (res.status === 404) throw new ApiError("Not found", 404);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new ApiError("Invalid response from the API", res.status);
  }
  if (!res.ok) throw new ApiError(`API error ${res.status}${body?.message ? ": " + body.message : ""}`, res.status);
  return body;
}

/** GET `path` (relative to the API base, e.g. "/blocks/1", or a full URL) and return the parsed JSON body. */
export async function get(path: string, priority: Priority = "interactive", signal?: AbortSignal): Promise<any> {
  const plan = RETRY[priority];
  let server = 0;
  let network = 0;
  let rate = 0;
  for (;;) {
    try {
      return await once(path, priority, signal);
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      if (e instanceof RateLimitError) {
        // one silent retry when the wait is short and the user is waiting on it
        if (priority === "interactive" && rate === 0 && e.seconds * 1000 <= MAX_SILENT_WAIT_MS) {
          rate++;
          await sleep(e.seconds * 1000 + 100);
          continue;
        }
        throw e;
      }
      const status: number | undefined = e?.status;
      if (status === undefined) {
        if (network >= plan.network.length) throw e;
        await sleep(plan.network[network++]);
      } else if (status >= 500) {
        if (server >= plan.server.length) throw e;
        await sleep(plan.server[server++]);
      } else {
        throw e; // 4xx: retrying will not help
      }
    }
  }
}

/** Rows deeper than this are read oldest-first (newest-first deep queries hit the 3.2 s timeout). */
export const DEEP_OFFSET = 20_000;

/**
 * One page of a newest-first list (`path` must already contain its filters, no page/limit/orderBy).
 * Pages deeper than DEEP_OFFSET rows are read oldest-first and reversed once the total is known;
 * newest-first is the fallback.
 */
export async function pagedNewestFirst<T>(
  path: string,
  page: number,
  limit: number,
  knownTotal: number,
  signal?: AbortSignal,
): Promise<{ data: T[]; totalCount: number }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = (p: number, dir: "asc" | "desc") => `${path}${sep}page=${p}&limit=${limit}&orderBy=timestamp:${dir}`;
  const offset = (page - 1) * limit;
  const newestFirst = async (priority: Priority = "interactive") => {
    const body = await get(url(page, "desc"), priority, signal);
    return { data: body.data as T[], totalCount: body.meta?.totalCount ?? 0 };
  };
  if (offset >= DEEP_OFFSET && !knownTotal) {
    // opened straight on a deep page: a one-row query for the total is far cheaper than a deep newest-first one
    const body = await get(`${path}${sep}page=1&limit=1`, "interactive", signal);
    knownTotal = body.meta?.totalCount ?? 0;
  }
  if (offset < DEEP_OFFSET || !knownTotal || offset >= knownTotal) return newestFirst();

  const oldestFirst = async (n: number, again = true): Promise<{ data: T[]; totalCount: number }> => {
    const take = Math.min(limit, n - offset);
    const start = n - offset - take;
    const first = Math.floor(start / limit) + 1;
    const pages = (start % limit) + take > limit ? [first, first + 1] : [first];
    const bodies = await Promise.all(pages.map((p) => get(url(p, "asc"), "interactive", signal)));
    const total: number = bodies[0].meta?.totalCount ?? n;
    // rows arrived since the total was counted: the window moved, read it again
    if (total !== n && again && offset < total) return oldestFirst(total, false);
    const rows = bodies.flatMap((b) => b.data as T[]);
    return { data: rows.slice(start % limit, (start % limit) + take).reverse(), totalCount: total };
  };
  try {
    return await oldestFirst(knownTotal);
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== undefined && e.status < 500)) throw e;
    return newestFirst("background");
  }
}
