// Minimaler x402-artiger Facilitator: verifiziert On-Chain-Zahlungen für Merchants,
// die IOTA von Agenten annehmen wollen. Bewusst NICHT custodial – der Zahler signiert
// und sendet selbst direkt an die Merchant-Adresse; der Facilitator liest nur die
// Chain und bestätigt, ob eine Zahlung zu den geforderten Bedingungen passt. Siehe
// docs/FACILITATOR.md für die Architektur- und Regulierungs-Einordnung.
import { getClient, txStatusFromResponse, isValidAddress } from './wallet.js';
import { insertFacilitatorReceipt, getFacilitatorReceipt } from './db.js';

const IOTA_COIN_TYPE_SUFFIX = '::iota::IOTA';

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
