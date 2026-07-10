// Orange-Bar Server: statische PWA + JSON-API.
import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { sessionMiddleware } from './session.js';
import { rateLimit } from './ratelimit.js';
import { authRouter } from './routes/auth.js';
import { externalRouter } from './routes/external.js';
import { walletRouter } from './routes/wallet.js';
import { payRouter } from './routes/pay.js';
import { twoFactorRouter } from './routes/twofactor.js';
import { pushRouter } from './routes/push.js';
import { projectsRouter } from './routes/projects.js';
import { identityRouter, verifyRouter } from './routes/identity.js';
import { startBalanceWatcher } from './push.js';
import { cleanupExpired } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(sessionMiddleware);

// CORS nur für die vom Spiel (fremde Origin) aufgerufenen APIs: Zahlungsanfragen
// und öffentliche Projekt-Infos. Bewusst OHNE credentials – session-gebundene
// Endpunkte (Wallet, Barkeeper, Gas-Bezug) bleiben damit same-origin.
const gameCors = (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
app.use('/api/pay', gameCors);
app.use('/api/projects', gameCors);
app.use('/api/verify', gameCors);

// Brute-Force-Schutz gezielt auf die sensiblen POST-Endpunkte (Login/Register).
// Bewusst NICHT auf GET /me & Co., die legitim häufig gepollt werden.
app.use('/api/auth/login', rateLimit({ windowMs: 60_000, max: 30 }));
app.use('/api/auth/register', rateLimit({ windowMs: 60_000, max: 30 }));
app.use('/api/auth', authRouter);
app.use('/api/auth/external', externalRouter);
app.use('/api/2fa', rateLimit({ windowMs: 60_000, max: 15 }), twoFactorRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/push', pushRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/pay', payRouter);
app.use('/api/identity', identityRouter);
app.use('/api/verify', verifyRouter);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: '1.0.0',
    rpId: config.rpId,
    networks: config.iotaNetworks,
    defaultNetwork: config.iotaNetwork,
    walletMode: config.walletMode,
    custodialMode: config.custodialMode,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    walletMode: config.walletMode,
    custodialMode: config.custodialMode,
    version: '1.0.0',
    rpName: config.rpName,
    networks: config.iotaNetworks,
  });
});

app.use(express.static(join(__dirname, '..', 'public')));

setInterval(cleanupExpired, 60_000).unref();

// Guthaben-Beobachter für Eingang-Benachrichtigungen (deaktivierbar für Tests).
if (process.env.ORANGE_DISABLE_WATCHER !== '1') {
  startBalanceWatcher(Number(process.env.ORANGE_WATCH_INTERVAL_MS || 30_000));
}

app.listen(config.port, () => {
  const local = config.rpId === 'localhost';
  console.log(`[orange-bar] Server hört auf Port ${config.port}`);
  console.log(`[orange-bar] Version 1.0.0 | Wallet-Modus: ${config.walletMode}`);
  if (config.custodialMode) {
    console.warn('[orange-bar] ⚠️  CUSTODIAL-MODUS AKTIV (ORANGE_CUSTODIAL_MODE=1)');
    console.warn('[orange-bar] ⚠️  Nutzer-Schlüssel liegen auf dem Server – MiCA-CASP-Pflicht in der EU möglich!');
    console.warn('[orange-bar] ⚠️  Siehe docs/CUSTODIAL.md – Standard ist Non-Custodial ohne diese Variable.');
  } else {
    console.log('[orange-bar] Non-Custodial-Modus (Standard): Server signiert keine Nutzer-Transaktionen.');
  }
  console.log(`[orange-bar] RP-ID: ${config.rpId} | Origins: ${config.origins.join(', ')}`);
  console.log(`[orange-bar] IOTA-Standardnetzwerk: ${config.iotaNetwork}`);
  if (local) {
    console.log('[orange-bar] Lokaler Entwicklungsmodus – erreichbar auf DIESEM Rechner unter');
    console.log(`[orange-bar]   http://localhost:${config.port}`);
    console.log('[orange-bar] Für echte Nutzer/Handys: HTTPS + eigene Domain, ORANGE_RP_ID & ORANGE_ORIGINS setzen.');
  }
});
