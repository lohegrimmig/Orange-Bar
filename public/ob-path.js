/** Basis-Pfad, wenn Orange-Bar unter z. B. `/orange-bar` hinter einem Reverse-Proxy liegt. */
export function orangeBarHttpBase() {
  if (typeof document === 'undefined') return '';
  const el = document.querySelector('meta[name="orange-bar-http-base"]');
  const raw = (el?.getAttribute('content') || '').trim();
  if (!raw || raw === '__ORANGE_BAR_HTTP_BASE__') return '';
  return raw.replace(/\/$/, '');
}

export function obUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = orangeBarHttpBase();
  return base ? `${base}${p}` : p;
}