// Wallet-API: Guthaben, NFTs, Aktivität, Netzwerk-Umschaltung und das
// Senden von IOTA/NFTs. Jede Sendung ist zweistufig: /tx/prepare erzeugt
// eine an die Transaktionsdaten gebundene Passkey-Challenge, /tx/confirm
// prüft die Passkey-Bestätigung (Gesicht/Finger) und führt erst dann aus.
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
  getPayRequest, updatePayRequestStatus, setUserNetwork, getProject,
  getSelfCustodyKeys, getWalletByUser, now,
} from '../db.js';
import {
  getAddress, getBalance, getOwnedObjects, getActivity,
  sendIota, sendObject, isValidAddress, NANOS_PER_IOTA,
  isSelfCustody, exportSeedHex, enableSelfCustody, enrollSelfCustodyDevice,
  buildTransferBytes, buildObjectTransferBytes, submitSignedTransaction,
  initSelfCustodyWallet, payRequestStatusFromChain,
} from '../wallet.js';
import { requireAuth } from '../session.js';
import { policyCheck } from '../identity/policy.js';

export const walletRouter = Router();
walletRouter.use(requireAuth);

const custodialOnly = (_req, res, next) => {
  if (!config.custodialMode) {
    return res.status(403).json({
      error: 'Dieser Endpunkt ist nur im Custodial-Modus verfügbar (ORANGE_CUSTODIAL_MODE=1). Standard ist Non-Custodial – siehe docs/CUSTODIAL.md.',
      code: 'custodial-only',
    });
  }
  next();
};

// Migration Custodial → Self-Custody: erlaubt, solange der Server noch einen
// Schlüssel für dieses Wallet hält – unabhängig vom Server-Modus. Sonst wären
// Altkonten aus der Custodial-Zeit im Non-Custodial-Betrieb eingefroren
// (tx/build verlangt Self-Custody, die Migration war aber custodialOnly).
const requireServerKey = (req, res, next) => {
  const row = getWalletByUser.get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  if (row.self_custody) return res.status(409).json({ error: 'Bereits Self-Custody.' });
  if (!row.key_ciphertext?.length) {
    return res.status(409).json({ error: 'Kein Server-Schlüssel für dieses Wallet vorhanden.' });
  }
  next();
};

const userNetwork = (req) => req.user.network || config.iotaNetwork;

walletRouter.get('/summary', async (req, res) => {
  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  const network = userNetwork(req);
  try {
    const balance = await getBalance(network, address);
    res.json({ address, network, networks: config.iotaNetworks, balance, nanosPerIota: String(NANOS_PER_IOTA) });
  } catch (err) {
    // Netzwerk nicht erreichbar → Adresse trotzdem anzeigen
    res.json({
      address, network, networks: config.iotaNetworks,
      balance: null, nanosPerIota: String(NANOS_PER_IOTA),
      networkError: `IOTA-Netzwerk nicht erreichbar: ${err.message}`,
    });
  }
});

// Netzwerk umschalten (testnet/devnet/mainnet) – wird pro Nutzer gespeichert.
walletRouter.post('/network', (req, res) => {
  const network = String(req.body?.network || '');
  if (!config.iotaNetworks.includes(network)) {
    return res.status(400).json({ error: `Netzwerk muss eines von ${config.iotaNetworks.join(', ')} sein.` });
  }
  setUserNetwork.run(network, req.user.id);
  res.json({ ok: true, network });
});

walletRouter.get('/nfts', async (req, res) => {
  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  try {
    const result = await getOwnedObjects(userNetwork(req), address, req.query.cursor || null);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `IOTA-Netzwerk nicht erreichbar: ${err.message}` });
  }
});

walletRouter.get('/activity', async (req, res) => {
  const address = getAddress(req.user.id);
  if (!address) return res.status(404).json({ error: 'Kein Wallet vorhanden.' });
  try {
    const items = await getActivity(userNetwork(req), address);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: `IOTA-Netzwerk nicht erreichbar: ${err.message}` });
  }
});

// ---------- Transaktion vorbereiten (nur Custodial-Modus) ----------
// body: { kind: 'iota'|'nft', to, amountNanos?, objectId?, payRequestId? }
walletRouter.post('/tx/prepare', custodialOnly, async (req, res) => {
  const { kind, to, amountNanos, objectId, payRequestId } = req.body || {};
  if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse (0x + 64 Hex-Zeichen).' });

  const network = userNetwork(req);
  let tx;
  if (kind === 'iota') {
    let amount;
    try { amount = BigInt(amountNanos); } catch { amount = 0n; }
    if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });
    tx = { kind, to, amountNanos: amount.toString(), network };
  } else if (kind === 'nft') {
    if (!/^0x[0-9a-fA-F]+$/.test(String(objectId || ''))) {
      return res.status(400).json({ error: 'Ungültige Objekt-ID.' });
    }
    tx = { kind, to, objectId, network };
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
    // Barkeeper-Policy (z. B. Altersbeschränkung) durchsetzen, bevor überhaupt
    // eine Passkey-Challenge erzeugt wird – siehe docs/IDENTITY_ARCHITECTURE.md.
    if (pr.project_id) {
      const project = getProject.get(pr.project_id);
      const check = policyCheck(project, req.user.id);
      if (!check.ok) {
        return res.status(403).json({
          error: 'Für dieses Projekt ist eine Altersverifizierung erforderlich.',
          code: 'policy-required', missing: check.missing, projectId: project.id,
        });
      }
    }
    tx.payRequestId = pr.id;
    tx.payOrigin = pr.origin;
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

// ---------- Transaktion mit Passkey bestätigen & ausführen (nur Custodial) ----------
walletRouter.post('/tx/confirm', custodialOnly, async (req, res) => {
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
      ? await sendIota(tx.network, req.user.id, tx.to, tx.amountNanos)
      : await sendObject(tx.network, req.user.id, tx.objectId, tx.to);
    if (tx.payRequestId) {
      updatePayRequestStatus.run(payRequestStatusFromChain(result.status), result.digest, tx.payRequestId);
    }
    res.json({ ok: true, ...result, tx });
  } catch (err) {
    res.status(502).json({ error: `Transaktion fehlgeschlagen: ${err.message}` });
  }
});

// ================= Self-Custody (non-custodial via WebAuthn-PRF) =================

// Status: ist Self-Custody aktiv, und für welche Passkeys liegt ein verschlüsselter
// Seed? (Der Client braucht die wrapped-Blobs zum lokalen Entschlüsseln.)
walletRouter.get('/custody', (req, res) => {
  const selfCustody = isSelfCustody(req.user.id);
  res.json({
    selfCustody,
    walletMode: config.walletMode,
    custodialMode: config.custodialMode,
    keys: selfCustody ? getSelfCustodyKeys.all(req.user.id) : [],
    credentials: getCredentialsByUser.all(req.user.id).map((c) => ({
      id: c.id, transports: JSON.parse(c.transports || '[]'),
    })),
  });
});

// Non-Custodial: Wallet nach Registrierung per PRF anlegen (Server erhält nie den Klartext-Seed).
walletRouter.post('/setup', async (req, res) => {
  if (config.custodialMode) {
    return res.status(400).json({ error: 'Wallet-Setup nur im Non-Custodial-Modus nötig.' });
  }
  if (getWalletByUser.get(req.user.id)) {
    return res.status(409).json({ error: 'Wallet existiert bereits.' });
  }
  const { credentialId, address, wrapped, publicKeyB64 } = req.body || {};
  const cred = getCredentialById.get(String(credentialId || ''));
  if (!cred || cred.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Passkey gehört nicht zu diesem Konto.' });
  }
  let publicKey;
  try {
    publicKey = Buffer.from(String(publicKeyB64 || ''), 'base64');
  } catch {
    return res.status(400).json({ error: 'Ungültiger Public Key.' });
  }
  try {
    const result = initSelfCustodyWallet(req.user.id, {
      address: String(address || ''),
      publicKey,
      credentialId: cred.id,
      wrapped: String(wrapped || ''),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Seed-Export nur mit frischer Passkey-Bestätigung und nur solange der Server
// noch einen Schlüssel hält (auch für Altkonten im Non-Custodial-Modus).
walletRouter.post('/custody/export/options', requireServerKey, async (req, res) => {
  const allowCredentials = getCredentialsByUser.all(req.user.id).map((c) => ({
    id: c.id, transports: JSON.parse(c.transports || '[]'),
  }));
  const options = await generateAuthenticationOptions({
    rpID: config.rpId, userVerification: 'required', allowCredentials,
  });
  const challengeId = randomUUID();
  insertChallenge.run(challengeId, 'export', req.user.id, options.challenge, null, now() + 120);
  res.json({ challengeId, options });
});

walletRouter.post('/custody/export/verify', requireServerKey, (req, res) => {
  const { challengeId, response } = req.body || {};
  const row = getChallenge.get(String(challengeId || ''));
  if (!row || row.kind !== 'export' || row.user_id !== req.user.id) {
    return res.status(400).json({ error: 'Unbekannte Challenge.' });
  }
  deleteChallenge.run(row.id);
  if (row.expires_at < now()) return res.status(400).json({ error: 'Challenge abgelaufen.' });
  const cred = getCredentialById.get(response?.id);
  if (!cred || cred.user_id !== req.user.id) return res.status(403).json({ error: 'Falscher Passkey.' });

  return verifyAuthenticationResponse({
    response, expectedChallenge: row.challenge, expectedOrigin: config.origins,
    expectedRPID: config.rpId, requireUserVerification: true,
    credential: {
      id: cred.id, publicKey: cred.public_key, counter: cred.counter,
      transports: JSON.parse(cred.transports || '[]'),
    },
  }).then((verification) => {
    if (!verification.verified) return res.status(401).json({ error: 'Bestätigung fehlgeschlagen.' });
    updateCredentialCounter.run(verification.authenticationInfo.newCounter, cred.id);
    res.json({ seedHex: exportSeedHex(req.user.id) });
  }).catch((err) => res.status(400).json({ error: `Passkey-Prüfung fehlgeschlagen: ${err.message}` }));
});

// Self-Custody aktivieren: verschlüsselten Seed für den aktuellen Passkey ablegen
// und den serverseitigen Schlüssel löschen (Punkt ohne Rückkehr).
walletRouter.post('/custody/enable', requireServerKey, (req, res) => {
  const { credentialId, wrapped } = req.body || {};
  const cred = getCredentialById.get(String(credentialId || ''));
  if (!cred || cred.user_id !== req.user.id) return res.status(403).json({ error: 'Falscher Passkey.' });
  if (typeof wrapped !== 'string' || wrapped.length < 20) return res.status(400).json({ error: 'Ungültiger Schlüssel.' });
  enableSelfCustody(req.user.id, cred.id, wrapped);
  res.json({ ok: true });
});

// Weiteres Gerät hinterlegen (Seed via Backup importiert, mit dessen PRF verschlüsselt).
walletRouter.post('/custody/enroll', (req, res) => {
  const { credentialId, wrapped } = req.body || {};
  const cred = getCredentialById.get(String(credentialId || ''));
  if (!cred || cred.user_id !== req.user.id) return res.status(403).json({ error: 'Falscher Passkey.' });
  if (typeof wrapped !== 'string' || wrapped.length < 20) return res.status(400).json({ error: 'Ungültiger Schlüssel.' });
  try {
    enrollSelfCustodyDevice(req.user.id, cred.id, wrapped);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Legacy-Konto aus der Custodial-Zeit: kann erst nach der Migration selbst signieren.
const notSelfCustody = (res) => res.status(400).json({
  error: 'Kein Self-Custody-Wallet – dieses Konto stammt noch aus dem Custodial-Modus. Bitte unter Mehr → Sicherheit auf Self-Custody umstellen.',
  code: 'not-self-custody',
});

// Tx-Bytes bauen, die der Client selbst signiert (Self-Custody / Non-Custodial).
walletRouter.post('/tx/build', async (req, res) => {
  if (!isSelfCustody(req.user.id)) return notSelfCustody(res);
  const { to, amountNanos, objectId, payRequestId } = req.body || {};
  const network = userNetwork(req);
  let txMeta = null;
  if (payRequestId) {
    const pr = getPayRequest.get(String(payRequestId));
    if (!pr || pr.status !== 'pending' || pr.expires_at < now()) {
      return res.status(400).json({ error: 'Zahlungsanfrage ungültig oder abgelaufen.' });
    }
    txMeta = { payRequestId: pr.id, payOrigin: pr.origin };
  }
  try {
    if (objectId) {
      if (!/^0x[0-9a-fA-F]+$/.test(String(objectId))) {
        return res.status(400).json({ error: 'Ungültige Objekt-ID.' });
      }
      if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse.' });
      const txBytesB64 = await buildObjectTransferBytes(network, getAddress(req.user.id), objectId, to);
      return res.json({ txBytesB64, tx: { kind: 'nft', to, objectId, network, ...txMeta } });
    }
    if (!isValidAddress(to)) return res.status(400).json({ error: 'Ungültige Zieladresse.' });
    let amount;
    try { amount = BigInt(amountNanos); } catch { amount = 0n; }
    if (amount <= 0n) return res.status(400).json({ error: 'Betrag muss größer als 0 sein.' });
    if (payRequestId) {
      const pr = getPayRequest.get(String(payRequestId));
      if (pr.to_address !== to || pr.amount !== amount.toString()) {
        return res.status(400).json({ error: 'Zahlungsanfrage passt nicht zur Transaktion.' });
      }
      if (pr.project_id) {
        const project = getProject.get(pr.project_id);
        const check = policyCheck(project, req.user.id);
        if (!check.ok) {
          return res.status(403).json({
            error: 'Für dieses Projekt ist eine Altersverifizierung erforderlich.',
            code: 'policy-required', missing: check.missing, projectId: project.id,
          });
        }
      }
    }
    const txBytesB64 = await buildTransferBytes(network, getAddress(req.user.id), to, amount.toString());
    res.json({
      txBytesB64,
      tx: { kind: 'iota', to, amountNanos: amount.toString(), network, ...txMeta },
    });
  } catch (err) {
    res.status(502).json({ error: `Transaktion konnte nicht gebaut werden: ${err.message}` });
  }
});

// Clientseitig signierte Transaktion ausführen.
walletRouter.post('/tx/submit', async (req, res) => {
  if (!isSelfCustody(req.user.id)) return notSelfCustody(res);
  const { txBytesB64, signatureB64, payRequestId } = req.body || {};
  if (!txBytesB64 || !signatureB64) return res.status(400).json({ error: 'Fehlende Signaturdaten.' });
  try {
    const result = await submitSignedTransaction(userNetwork(req), txBytesB64, signatureB64);
    if (payRequestId) {
      updatePayRequestStatus.run(payRequestStatusFromChain(result.status), result.digest, payRequestId);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: `Transaktion fehlgeschlagen: ${err.message}` });
  }
});
