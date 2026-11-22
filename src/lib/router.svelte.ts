// Hash routing (#/block/123): works on any static webserver without rewrite rules.

export const route = $state({ parts: [] as string[], query: {} as Record<string, string> });

function parse() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  route.parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  route.query = Object.fromEntries(new URLSearchParams(qs));
}

export function startRouter() {
  parse();
  window.addEventListener("hashchange", () => {
    parse();
    window.scrollTo(0, 0);
  });
}

export function go(path: string) {
  location.hash = "#" + path;
}

export function setQuery(q: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...route.query, ...q })) if (v !== undefined && v !== "") params.set(k, String(v));
  const s = params.toString();
  history.replaceState(null, "", "#/" + route.parts.map(encodeURIComponent).join("/") + (s ? "?" + s : ""));
  parse();
}

export const link = {
  block: (idOrHeight: string | number) => `#/block/${idOrHeight}`,
  tx: (id: string) => `#/transaction/${id}`,
  wallet: (address: string) => `#/wallet/${address}`,
};
