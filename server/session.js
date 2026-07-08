// Einfache Cookie-Sessions: zufälliges Token, HttpOnly-Cookie, Ablauf in DB.
import { randomBytes } from 'node:crypto';
import { insertSession, getSession, deleteSession, getUserById, now } from './db.js';
import { config } from './config.js';

const COOKIE = 'ob_session';

export function createSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  insertSession.run(token, userId, now() + config.sessionTtlSeconds);
  const secure = config.origins.some((o) => o.startsWith('https://'));
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: config.sessionTtlSeconds * 1000,
    path: '/',
  });
  return token;
}

export function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) deleteSession.run(token);
  res.clearCookie(COOKIE, { path: '/' });
}

/** Middleware: hängt req.user an, wenn eine gültige Session existiert. */
export function sessionMiddleware(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    const s = getSession.get(token);
    if (s && s.expires_at > now()) {
      req.user = getUserById.get(s.user_id) || null;
    } else if (s) {
      deleteSession.run(token);
    }
  }
  next();
}

/** Middleware: blockt unauthentifizierte Anfragen. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  next();
}
