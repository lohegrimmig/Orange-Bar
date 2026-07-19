// Minimaler x402-artiger Facilitator: verifiziert On-Chain-Zahlungen für Merchants,
// die IOTA von Agenten annehmen wollen. Bewusst NICHT custodial – der Zahler signiert
// und sendet selbst direkt an die Merchant-Adresse; der Facilitator liest nur die
// Chain und bestätigt, ob eine Zahlung zu den geforderten Bedingungen passt. Siehe
// docs/FACILITATOR.md für die Architektur- und Regulierungs-Einordnung.
import { randomBytes, randomInt } from 'node:crypto';
import { getClient, txStatusFromResponse, isValidAddress } from './wallet.js';
import {
  insertFacilitatorReceipt, getFacilitatorReceipt,
  insertFacilitatorChallenge, getFacilitatorChallenge, consumeFacilitatorChallenge,
} from './db.js';

const IOTA_COIN_TYPE_SUFFIX = '::iota::IOTA';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 Minuten
// Zufälliger Mikro-Aufschlag (< 0,001 IOTA) macht den geforderten Betrag pro
// Challenge quasi-eindeutig – ökonomisch irrelevant, aber genug, um zwei
// gleichzeitig offene Challenges zum selben Grundpreis zu unterscheiden.
const AMOUNT_JITTER_MAX_NANOS = 999_999;

/** Reine Prüf-Logik ohne Netzwerkzugriff – testbar mit einer Fake-Tx-Antwort. */
export function matchesPayment(txResponse, { payTo, amountNanos }) {
  if (txStatusFromResponse(txResponse) !== 'success') {
    return { ok: false, error: 'Transaktion ist on-chain nicht erfolgreich.', code: 'status' };
  }
  const target = String(payTo).trim().toLowerCase();
  const need = BigInt(amountNanos);
  const change = (txResponse.balanceChanges || []).find(
    (c) => c.owner?.AddressOwner?.toLowerCase() === target && c.coinType?.endsWith(IOTA_COIN_TYPE_SUFFIX),
  );
  if (!change) return { ok: false, error: 'Keine passende Gutschrift an die Zieladresse gefunden.', code: 'nomatch' };
  const received = BigInt(change.amount);
  if (received < need) {
    return { ok: false, error: `Gutschrift zu gering (${received} < ${need} Nanos).`, code: 'amount' };
  }
  return { ok: true, receivedNanos: received.toString() };
}

/** Holt eine Transaktion per Digest vom Netzwerk und prüft sie gegen die Anforderungen. */
export async function verifyPayment({ network, digest, payTo, amountNanos }) {
  if (!isValidAddress(payTo)) return { ok: false, error: 'Ungültige payTo-Adresse.', code: 'address' };
  let need;
  try { need = BigInt(amountNanos); } catch { need = -1n; }
  if (need <= 0n) return { ok: false, error: 'amountNanos muss größer als 0 sein.', code: 'amount' };
  if (!digest || typeof digest !== 'string') {
    return { ok: false, error: 'digest erforderlich.', code: 'digest' };
  }

  const client = getClient(network);
  let tx;
  try {
    tx = await client.getTransactionBlock({
      digest,
      options: { showEffects: true, showBalanceChanges: true },
    });
  } catch (err) {
    return { ok: false, error: `Transaktion nicht gefunden: ${err.message}`, code: 'notfound' };
  }
  return matchesPayment(tx, { payTo, amountNanos: need.toString() });
}

/**
 * Wie verifyPayment, verbraucht den Zahlungsbeweis dabei aber genau einmal.
 * Replay-Schutz läuft über den PRIMARY KEY auf `digest` — auch bei gleichzeitigen
 * Aufrufen für denselben Digest gewinnt nur ein INSERT, der Rest bekommt 'replay'.
 */
export async function settlePayment({ network, digest, payTo, amountNanos, resource = null }) {
  if (digest && getFacilitatorReceipt.get(digest)) {
    return { ok: false, error: 'Zahlungsbeweis wurde bereits verbraucht.', code: 'replay' };
  }
  const verified = await verifyPayment({ network, digest, payTo, amountNanos });
  if (!verified.ok) return verified;
  try {
    insertFacilitatorReceipt.run(digest, network, payTo, String(amountNanos), resource, Date.now());
  } catch {
    return { ok: false, error: 'Zahlungsbeweis wurde bereits verbraucht.', code: 'replay' };
  }
  return { ok: true, digest, network, receivedNanos: verified.receivedNanos };
}

/**
 * Erstellt eine Zahlungs-Challenge für eine konkrete 402-Anfrage. Bindet den
 * späteren Zahlungsbeweis an GENAU DIESE Anfrage (per Einmal-`challengeId` +
 * einem quasi-eindeutigen Betrag), statt nur an Adresse/Grund-Betrag – ohne
 * diese Bindung könnte ein Dritter einen öffentlich sichtbaren Tx-Digest vor
 * dem echten Zahler beim Merchant einlösen ("Digest-Front-Running"), weil
 * IOTA-Überweisungen kein On-Chain-Memo-Feld haben, das eine Anfrage-ID tragen
 * könnte. Siehe docs/FACILITATOR.md § 5.
 */
export function createPaymentChallenge({ network, payTo, baseAmountNanos, resource = null, ttlMs = CHALLENGE_TTL_MS }) {
  if (!isValidAddress(payTo)) throw new Error('Ungültige payTo-Adresse.');
  let base;
  try { base = BigInt(baseAmountNanos); } catch { base = -1n; }
  if (base <= 0n) throw new Error('baseAmountNanos muss größer als 0 sein.');

  const id = `pc_${randomBytes(18).toString('base64url')}`;
  const amountNanos = (base + BigInt(randomInt(0, AMOUNT_JITTER_MAX_NANOS + 1))).toString();
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;
  insertFacilitatorChallenge.run(id, network, payTo, amountNanos, resource, createdAt, expiresAt);
  return { challengeId: id, network, payTo, amountNanos, resource, expiresAt };
}

/**
 * Löst eine Challenge gegen einen Tx-Digest ein. Verbraucht sowohl die
 * Challenge (bedingtes UPDATE, race-sicher wie die Stations-Zahlungen seit
 * v1.1.1) als auch – über settlePayment – den Digest selbst global. Nur eine
 * EXAKTE Übereinstimmung mit dem der Challenge zugewiesenen Betrag zählt,
 * damit ein anderweitig beobachteter Digest diese spezielle Challenge nicht
 * zufällig erfüllt.
 */
export async function settleChallenge({ challengeId, digest }) {
  const challenge = getFacilitatorChallenge.get(challengeId);
  if (!challenge) {
    return { ok: false, error: 'Unbekannte oder abgelaufene Zahlungs-Challenge.', code: 'challenge' };
  }
  if (challenge.consumed_at) {
    return { ok: false, error: 'Zahlungs-Challenge wurde bereits verbraucht.', code: 'replay' };
  }
  if (challenge.expires_at <= Date.now()) {
    return { ok: false, error: 'Zahlungs-Challenge ist abgelaufen.', code: 'expired' };
  }

  const settled = await settlePayment({
    network: challenge.network,
    digest,
    payTo: challenge.pay_to,
    amountNanos: challenge.amount_nanos,
    resource: challenge.resource,
  });
  if (!settled.ok) return settled;

  if (settled.receivedNanos !== challenge.amount_nanos) {
    // matchesPayment lässt "mindestens" durch; für eine Challenge zählt nur
    // der ihr exakt zugewiesene Betrag als Bindung (siehe Modul-Kommentar).
    return {
      ok: false,
      error: 'Gutschrift entspricht nicht exakt dem für diese Challenge geforderten Betrag.',
      code: 'amount',
    };
  }

  const consumed = consumeFacilitatorChallenge.run(Date.now(), digest, challengeId, Date.now());
  if (consumed.changes === 0) {
    return { ok: false, error: 'Zahlungs-Challenge wurde inzwischen von einem anderen Request verbraucht.', code: 'replay' };
  }
  return { ok: true, digest, network: challenge.network, receivedNanos: settled.receivedNanos, resource: challenge.resource };
}
