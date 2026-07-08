// Orange-Bar Server: statische PWA + JSON-API.
import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { sessionMiddleware } from './session.js';
import { rateLimit } from './ratelimit.js';
import { authRouter } from './routes/auth.js';
import { walletRouter } from './routes/wallet.js';
import { payRouter } from './routes/pay.js';
import { adminRouter } from './routes/admin.js';
import { twoFactorRouter } from './routes/twofactor.js';
import { cleanupExpired } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(sessionMiddleware);

// CORS nur für die Pay-API (Spiele laufen auf fremden Origins).
// Die Auth-/Wallet-API bleibt bewusst same-origin.
app.use('/api/pay', (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Brute-Force-Schutz auf Auth- und 2FA-Endpunkten.
app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 30 }), authRouter);
app.use('/api/2fa', rateLimit({ windowMs: 60_000, max: 15 }), twoFactorRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/admin', adminRouter);
app.use('/api/pay', payRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rpId: config.rpId, networks: config.iotaNetworks, defaultNetwork: config.iotaNetwork });
});

app.use(express.static(join(__dirname, '..', 'public')));

setInterval(cleanupExpired, 60_000).unref();

app.listen(config.port, () => {
  console.log(`[orange-bar] läuft auf Port ${config.port}`);
  console.log(`[orange-bar] RP-ID: ${config.rpId} | Origins: ${config.origins.join(', ')}`);
  console.log(`[orange-bar] IOTA-Netzwerk: ${config.iotaNetwork}`);
});
