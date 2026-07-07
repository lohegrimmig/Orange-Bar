// Wallet-API: Guthaben, NFTs, und das Senden von IOTA/NFTs.
// Jede Sendung ist zweistufig: /tx/prepare erzeugt eine an die
// Transaktionsdaten gebundene Passkey-Challenge, /tx/confirm prüft die
// Passkey-Bestätigung (Gesicht/Finger) und führt erst dann aus.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import {
  getCredentialById, getCredentialsByUser, updateCredentialCounter,
  insertChallenge, getChallenge, deleteChallenge,
  getPayRequest, updatePayRequestStatus, now,
} from '../db.js';
import {
  getAddress, getBalance, getOwnedObjects,
  sendIota, sendObject, isValidAddress, NANOS_PER_IOTA,
} from '../wallet.js';
import { requireAuth } from '../session.js';

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get('/summary', async (req, res) => {
  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  try {
    const balance = await getBalance(address);
    res.json({ address, network: config.iotaNetwork, balance, nanosPerIota: String(NANOS_PER_IOTA) });
  } catch (err) {
    // Netzwerk nicht erreichbar → Adresse trotzdem anzeigen
    res.json({
      address, network: config.iotaNetwork,
      balance: null, nanosPerIota: String(NANOS_PER_IOTA),
      networkError: `IOTA-Netzwerk nicht erreichbar: ${err.message}`,
    });
  }
});

walletRouter.get('/nfts', async (req, res) => {
  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  try {
    const result = await getOwnedObjects(address, req.query.cursor || null);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `IOTA-Netzwerk nicht erreichbar: ${err.message}` });
  }
});

// ---------- Transaktion vorbereiten ----------
// body: { kind: 'iota'|'nft', to, amountNanos?, objectId?, payRequestId? }
walletRouter.post('/tx/prepare', async (req, res) => {
  const { kind, to, amountNanos, objectId, payRequestId } = req.body || {};
  if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse (0x + 64 Hex-Zeichen).' });

  let tx;
  if (kind === 'iota') {
    let amount;
    try { amount = BigInt(amountNanos); } catch { amount = 0n; }
    if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });
    tx = { kind, to, amountNanos: amount.toString() };
  } else if (kind === 'nft') {
    if (!/^0x[0-9a-fA-F]+$/.test(String(objectId || ''))) {
      return res.status(400).json({ error: 'Ungültige Objekt-ID.' });
    }
    tx = { kind, to, objectId };
  } else {
    return res.status(400).json({ error: "kind muss 'iota' oder 'nft' sein." });
  }
  if (payRequestId) {
    const pr = getPayRequest.get(String(payRequestId));
    if (!pr || pr.status !== 'pending' || pr.expires_at < now()) {
      return res.status(400).json({ error: 'Zahlungsanfrage ungültig oder abgelaufen.' });
    }
    if (pr.to_address !== to || pr.amount !== tx.amountNanos) {
      return res.status(400).json({ error: 'Zahlungsanfrage passt nicht zur Transaktion.' });
    }
    tx.payRequestId = pr.id;
  }

  // Passkey-Challenge, fest an genau diese Transaktionsdaten gebunden.
  const allowCredentials = getCredentialsByUser.all(req.user.id).map((c) => ({
    id: c.id,
    transports: JSON.parse(c.transports || '[]'),
  }));
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials,
  });
  const challengeId = randomUUID();
  insertChallenge.run(
    challengeId, 'tx', req.user.id, options.challenge,
    JSON.stringify(tx), now() + config.txChallengeTtlSeconds
  );
  res.json({ challengeId, options, tx });
});

// ---------- Transaktion mit Passkey bestätigen & ausführen ----------
walletRouter.post('/tx/confirm', async (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'tx' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Transaktions-Challenge.' });
  }
  deleteChallenge.run(row.id); // Einmal-Verwendung, auch bei Fehlern
  if (row.expires_at < now()) {
    return res.status(400).json({ error: 'Bestätigung abgelaufen – bitte Transaktion neu starten.' });
  }

  const cred = getCredentialById.get(response?.id);
  if (!cred || cred.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Passkey gehört nicht zu diesem Konto.' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: cred.public_key,
        counter: cred.counter,
        transports: JSON.parse(cred.transports || '[]'),
      },
    });
  } catch (err) {
    return res.status(400).json({ error: `Passkey-Prüfung fehlgeschlagen: ${err.message}` });
  }
  if (!verification.verified) return res.status(401).json({ error: 'Bestätigung fehlgeschlagen.' });
  updateCredentialCounter.run(verification.authenticationInfo.newCounter, cred.id);

  const tx = JSON.parse(row.payload);
  try {
    const result = tx.kind === 'iota'
      ? await sendIota(req.user.id, tx.to, tx.amountNanos)
      : await sendObject(req.user.id, tx.objectId, tx.to);
    if (tx.payRequestId) {
      updatePayRequestStatus.run(result.status === 'success' ? 'confirmed' : 'pending', result.digest, tx.payRequestId);
    }
    res.json({ ok: true, ...result, tx });
  } catch (err) {
    res.status(502).json({ error: `Transaktion fehlgeschlagen: ${err.message}` });
  }
});
