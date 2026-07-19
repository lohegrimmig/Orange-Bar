// Facilitator-API (x402-artig, verify-only) für Merchants/Resource-Server, die
// IOTA-Zahlungen von Agenten annehmen wollen. Kein Custody: der Facilitator bewegt
// nie Assets, er liest nur die Chain und bestätigt/verbraucht einen Zahlungsbeweis.
// Siehe docs/FACILITATOR.md.
import { Router } from 'express';
import { verifyPayment, settlePayment, createPaymentChallenge, settleChallenge } from '../facilitator.js';
import { paywall } from '../paywall.js';
import { config } from '../config.js';
import { rateLimit } from '../ratelimit.js';

export const facilitatorRouter = Router();

facilitatorRouter.get('/supported', (_req, res) => {
  res.json({
    kinds: config.iotaNetworks.map((network) => ({
      scheme: 'exact',
      network: `iota:${network}`,
      asset: 'IOTA',
    })),
  });
});

function readPaymentBody(req, res) {
  const { network, digest, payTo, amountNanos } = req.body || {};
  if (!config.iotaNetworks.includes(network)) {
    res.status(400).json({ error: 'Unbekanntes Netzwerk.' });
    return null;
  }
  return { network, digest, payTo, amountNanos, resource: req.body?.resource || null };
}

facilitatorRouter.post('/verify', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
  const body = readPaymentBody(req, res);
  if (!body) return;
  const result = await verifyPayment(body);
  res.json({ isValid: result.ok, error: result.ok ? undefined : result.error, code: result.code });
});

// Erzeugt eine Einmal-Challenge für eine konkrete Zahlungsanfrage (siehe
// docs/FACILITATOR.md § 5) – für Merchants außerhalb von server/paywall.js,
// die trotzdem das Digest-Front-Running-Problem vermeiden wollen.
facilitatorRouter.post('/challenge', rateLimit({ windowMs: 60_000, max: 120 }), (req, res) => {
  const { network, payTo, amountNanos, resource } = req.body || {};
  if (!config.iotaNetworks.includes(network)) {
    return res.status(400).json({ error: 'Unbekanntes Netzwerk.' });
  }
  try {
    const challenge = createPaymentChallenge({ network, payTo, baseAmountNanos: amountNanos, resource: resource || null });
    res.status(201).json(challenge);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Challenge konnte nicht erzeugt werden.' });
  }
});

// Mit `challengeId` im Body: race-sicher an die konkrete Anfrage gebunden (empfohlen).
// Ohne `challengeId`: alter, einfacher Pfad – nur Adresse+Betrag+Digest, OHNE
// Schutz vor Digest-Front-Running (siehe docs/FACILITATOR.md § 5/§ 6). Nur
// verwenden, wenn der Merchant selbst eine gleichwertige Bindung umsetzt.
facilitatorRouter.post('/settle', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
  if (req.body?.challengeId) {
    const result = await settleChallenge({ challengeId: req.body.challengeId, digest: req.body?.digest });
    if (!result.ok) {
      const status = result.code === 'replay' ? 409
        : (result.code === 'challenge' || result.code === 'expired') ? 400
        : result.code === 'notfound' ? 404 : 400;
      return res.status(status).json({ success: false, error: result.error, code: result.code });
    }
    return res.json({ success: true, digest: result.digest, network: result.network });
  }

  const body = readPaymentBody(req, res);
  if (!body) return;
  const result = await settlePayment(body);
  if (!result.ok) {
    const status = result.code === 'replay' ? 409 : result.code === 'notfound' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }
  res.json({ success: true, digest: result.digest, network: result.network });
});

// Demo-Merchant-Route: nur aktiv, wenn eine Empfänger-Adresse konfiguriert ist
// (ORANGE_FACILITATOR_DEMO_PAYTO). Zeigt den vollen 402 → zahlen → freischalten-Flow.
if (config.facilitatorDemoPayTo) {
  facilitatorRouter.get(
    '/demo/resource',
    paywall({
      network: config.iotaNetwork,
      payTo: config.facilitatorDemoPayTo,
      amountNanos: config.facilitatorDemoAmountNanos,
      resource: '/api/facilitator/demo/resource',
    }),
    (_req, res) => {
      res.json({ content: 'Bezahlter Inhalt – danke für die Zahlung!', paidAt: Date.now() });
    },
  );
}
