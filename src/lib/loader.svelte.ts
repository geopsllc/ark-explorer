import { RateLimitError } from "./api";

/**
 * Load data for a page: tracks loading/error, cancels on reload, and when the rate limit is hit
 * it waits and retries by itself (showing "Retrying in Ns…").
 */
export function loader<T>(fn: (signal: AbortSignal) => Promise<T>) {
  const s = $state({ data: null as T | null, loading: true, error: "" });
  let ctrl: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function run(keep = false) {
    ctrl?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    const c = (ctrl = new AbortController());
    s.loading = true;
    if (!keep) s.data = null;
    s.error = "";
    try {
      const d = await fn(c.signal);
      if (c.signal.aborted) return;
      s.data = d;
    } catch (e: any) {
      if (c.signal.aborted || e?.name === "AbortError") return;
      s.error = e?.message ?? String(e);
      if (e instanceof RateLimitError) retryTimer = setTimeout(() => run(keep), e.seconds * 1000 + 200);
    } finally {
      if (!c.signal.aborted) s.loading = false;
    }
  }

  return {
    get state() {
      return s;
    },
    run,
    destroy() {
      ctrl?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
