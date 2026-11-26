/**
 * Every API request goes through here. Timeouts, retries and pacing were tuned on api.ark.io
 * (ARK Core) and kept for the Mainsail API, which runs the same kind of public API behind the
 * same per-IP limit (x-ratelimit-limit: 200):
 *
 * - Rate limit: 200 requests per 60 s window per IP. Browsers cannot read Retry-After /
 *   X-RateLimit-* (not in Access-Control-Expose-Headers), so we never want to hit it: requests
 *   are counted in a sliding 60 s window and each priority stops at its own share of
 *   REQUEST_BUDGET (170, leaving headroom for other tabs and apps on the same IP). After a 429
 *   the host is paused and probed every 10 s.
 * - Block lists are always read by number range (/blocks?number.from=&number.to=): cheap and
 *   exact, also for the live poller.
 * - Deep newest-first pages are read oldest-first and reversed (see `pagedNewestFirst`).
 *
 * Priorities:
 * - interactive (what the user is looking at): 10 s timeout, 500 retried after 0.3 s and 1 s,
 *   network errors after 0.5 s and 1.5 s, 4xx never.
 * - live (block poller): 3 s timeout, no retries: the next poll is at most a few seconds away.
 * - background (directory): 8 s timeout, no retries; paused when the budget runs low.
 * - bulk (the 24 h missed-block scan, ~110 requests): like background but with a smaller share, so a
 *   first visit's scan cannot hold up the directory pages on screen.
 */
import { PRIMARY_API, REQUEST_BUDGET } from "./site";

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

const started: number[] = []; // request start times inside the window
let pausedUntil = 0; // after a 429: no requests before this (except the probe)
let probing = false;

export const stats = { requests: 0, last429: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prune(now: number) {
  while (started.length && now - started[0] >= WINDOW_MS) started.shift();
}

/** Milliseconds until `priority` may start a request (0 = now). */
function budgetWait(priority: Priority, now: number): number {
  prune(now);
  if (now < pausedUntil) return pausedUntil - now;
  const limit = Math.floor(REQUEST_BUDGET * SHARE[priority]);
  if (started.length < limit) return 0;
  return started[started.length - limit] + WINDOW_MS - now + 5;
}

async function acquire(priority: Priority) {
  for (;;) {
    const wait = budgetWait(priority, Date.now());
    if (wait === 0) break;
    if (priority === "interactive" && wait > MAX_SILENT_WAIT_MS) throw new RateLimitError(wait / 1000);
    if (priority === "live" && wait > 1000) throw new RateLimitError(wait / 1000); // the poller retries on its own schedule
    await sleep(Math.min(wait, 1000));
  }
  started.push(Date.now());
  stats.requests++;
}

/** After a 429 nothing is sent until a cheap probe gets through (every 10 s). */
function startProbe() {
  if (probing) return;
  probing = true;
  pausedUntil = Date.now() + PROBE_MS;
  (async () => {
    for (;;) {
      await sleep(Math.max(0, pausedUntil - Date.now()));
      try {
        const res = await fetch(PRIMARY_API + "/blockchain", { cache: "no-store" });
        if (res.status !== 429) break;
      } catch {
        /* network trouble: keep probing */
      }
      pausedUntil = Date.now() + PROBE_MS;
    }
    pausedUntil = 0;
    probing = false;
  })();
}

async function once(path: string, priority: Priority, signal?: AbortSignal): Promise<any> {
  await acquire(priority);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT[priority]);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  let res: Response;
  try {
    res = await fetch(/^https?:/.test(path) ? path : PRIMARY_API + path, { signal: ctrl.signal, cache: "no-store" });
  } catch (e: any) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new ApiError(ctrl.signal.aborted ? "The API did not answer in time" : "Network error");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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
