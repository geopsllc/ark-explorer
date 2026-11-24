"""Minimal ARK Core v3 API client tuned to api.ark.io's measured behaviour
(see ark-wallet README "API behaviour" / ark-explorer src/lib/api.ts):

- Rate limit: 200 requests per fixed 60 s window per IP. We budget BUDGET per window
  (leaving headroom for other tabs/apps on the same IP) and sleep to the next window.
- A 429 carries Retry-After (readable outside the browser): we pause for that long, else probe every 10 s.
- Latency 0.1-0.9 s, heavy queries up to ~3.3 s: 5 s connect / 10 s total timeout.
- Overload returns 500 after ~3.2 s: retried after 0.3 s and 1 s. Network errors after 0.5 s and 1.5 s.
- Newest-first pages deeper than ~20k rows fail: deep pages are read oldest-first (not needed here:
  we only read recent history).
"""
import json, socket, sys, time, urllib.error, urllib.request

API = "https://api.ark.io/api"
WINDOW = 60.0
BUDGET = 180            # of 200/window
CONNECT_TIMEOUT = 5
TOTAL_TIMEOUT = 10
SERVER_RETRY = [0.3, 1.0]
NETWORK_RETRY = [0.5, 1.5]
PROBE = 10.0


class ApiError(Exception):
    pass


class Client:
    def __init__(self, base=API, budget=BUDGET, verbose=False):
        self.base = base
        self.budget = budget
        self.verbose = verbose
        self.window_start = 0.0
        self.used = 0
        self.paused_until = 0.0
        self.requests = 0

    def _pace(self):
        now = time.time()
        if now < self.paused_until:
            time.sleep(self.paused_until - now)
            now = time.time()
        if now - self.window_start >= WINDOW:
            self.window_start, self.used = now, 0
        if self.used >= self.budget:
            wait = self.window_start + WINDOW - now
            if self.verbose:
                print(f"  [rate] budget used, waiting {wait:.0f}s", file=sys.stderr)
            time.sleep(max(0, wait))
            self.window_start, self.used = time.time(), 0
        self.used += 1
        self.requests += 1

    def _once(self, path):
        self._pace()
        req = urllib.request.Request(self.base + path, headers={"User-Agent": "ark-share-analyzer"})
        # urllib has one timeout for connect and each read; the total cap is enforced by the socket default
        with urllib.request.urlopen(req, timeout=TOTAL_TIMEOUT) as r:
            return json.load(r)

    def get(self, path):
        srv, net = list(SERVER_RETRY), list(NETWORK_RETRY)
        while True:
            try:
                return self._once(path)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    ra = e.headers.get("Retry-After")
                    wait = float(ra) if ra and ra.replace(".", "").isdigit() else PROBE
                    if self.verbose:
                        print(f"  [rate] 429, pausing {wait:.0f}s", file=sys.stderr)
                    self.paused_until = time.time() + wait
                    continue
                if e.code >= 500 and srv:
                    time.sleep(srv.pop(0))
                    continue
                raise ApiError(f"{e.code} {path}") from e
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
                if net:
                    time.sleep(net.pop(0))
                    continue
                raise ApiError(f"network {path}: {e}") from e

    def pages(self, path, limit=100, max_pages=1000, stop=None):
        """Yield rows page by page (newest-first as the endpoint orders them). `stop(row)` ends early."""
        sep = "&" if "?" in path else "?"
        for page in range(1, max_pages + 1):
            d = self.get(f"{path}{sep}limit={limit}&page={page}")
            rows = d.get("data", [])
            for r in rows:
                if stop and stop(r):
                    return
                yield r
            if len(rows) < limit or not d["meta"].get("next"):
                return
