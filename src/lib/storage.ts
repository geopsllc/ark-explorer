// localStorage that never throws (private windows, blocked site data, quota).

export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or disabled: caching is only an optimisation */
  }
}

export function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
