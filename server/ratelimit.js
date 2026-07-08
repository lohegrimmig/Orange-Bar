// Einfaches In-Memory-Rate-Limiting (Sliding Window) pro IP.
// Schützt Auth-/2FA-Endpunkte gegen Brute-Force. Für Multi-Instanz-Betrieb
// später durch Redis o. Ä. ersetzen.
const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 30, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let hits = buckets.get(k);
    if (!hits) buckets.set(k, (hits = []));
    while (hits.length && hits[0] <= t - windowMs) hits.shift();
    if (hits.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Zu viele Versuche – bitte kurz warten.' });
    }
    hits.push(t);
    next();
  };
}

// Speicher regelmäßig aufräumen.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, hits] of buckets) {
    if (!hits.length || hits[hits.length - 1] < cutoff) buckets.delete(k);
  }
}, 5 * 60_000).unref();
