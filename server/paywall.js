// Merchant-seitige x402-artige Paywall: antwortet ohne Zahlungsbeweis mit HTTP 402
// und den Zahlungsanforderungen, prüft einen mitgelieferten Beweis über den lokalen
// Facilitator (server/facilitator.js) und lässt ihn nur einmal passieren. Für eigene
// Routen gedacht, die IOTA-Zahlungen von Agenten annehmen wollen. Siehe docs/FACILITATOR.md.
import { settlePayment } from './facilitator.js';

/** Express-Middleware. `resource` identifiziert die geschützte Route (Replay-Kontext). */
export function paywall({ network, payTo, amountNanos, resource }) {
  return async (req, res, next) => {
    const digest = req.get('X-Payment-Digest');
    if (!digest) {
      return res.status(402).json({
        x402Version: 1,
        accepts: [{
          scheme: 'exact',
          network: `iota:${network}`,
          asset: 'IOTA',
          payTo,
          amountNanos: String(amountNanos),
          resource,
        }],
      });
    }
    const result = await settlePayment({ network, digest, payTo, amountNanos, resource });
    if (!result.ok) {
      const status = result.code === 'replay' ? 409 : 402;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    req.payment = result;
    next();
  };
}
