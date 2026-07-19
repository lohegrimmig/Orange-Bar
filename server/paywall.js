// Merchant-seitige x402-artige Paywall: antwortet ohne Zahlungsbeweis mit HTTP 402
// und einer Einmal-Challenge, prüft einen mitgelieferten Beweis GEGEN GENAU DIESE
// Challenge über den lokalen Facilitator (server/facilitator.js) und lässt ihn nur
// einmal passieren. Für eigene Routen gedacht, die IOTA-Zahlungen von Agenten
// annehmen wollen. Siehe docs/FACILITATOR.md.
//
// Warum eine Challenge statt nur Adresse+Betrag: Tx-Digests sind öffentlich, sobald
// die Zahlung on-chain bestätigt ist. Ohne Bindung an die konkrete Anfrage könnte ein
// Dritter einen fremden, frisch bestätigten Digest beobachten und ihn hier VOR dem
// echten Zahler einlösen ("Digest-Front-Running") – der Merchant bekäme sein Geld,
// aber der Falsche die Ressource. Die Challenge (Einmal-ID + quasi-eindeutiger
// Betrag) bindet den Beweis an genau die 402-Antwort, die der Zahler erhalten hat.
import { createPaymentChallenge, settleChallenge } from './facilitator.js';

/** Express-Middleware. `resource` identifiziert die geschützte Route (nur Doku/Log). */
export function paywall({ network, payTo, amountNanos, resource }) {
  return async (req, res, next) => {
    const digest = req.get('X-Payment-Digest');
    const challengeId = req.get('X-Payment-Challenge');

    if (!digest || !challengeId) {
      const challenge = createPaymentChallenge({ network, payTo, baseAmountNanos: amountNanos, resource });
      return res.status(402).json({
        x402Version: 1,
        accepts: [{
          scheme: 'exact',
          network: `iota:${network}`,
          asset: 'IOTA',
          payTo,
          amountNanos: challenge.amountNanos,
          resource,
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
        }],
      });
    }

    const result = await settleChallenge({ challengeId, digest });
    if (!result.ok) {
      const status = result.code === 'replay' ? 409
        : (result.code === 'challenge' || result.code === 'expired') ? 400
        : 402;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    req.payment = result;
    next();
  };
}
