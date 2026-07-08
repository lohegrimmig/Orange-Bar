// Zentrale Konfiguration – alles per Umgebungsvariable überschreibbar.
// Passkeys (WebAuthn) funktionieren nur über HTTPS oder auf localhost.

const PORT = Number(process.env.PORT || 8787);

// Relying-Party-ID = Domain, unter der die App läuft (ohne Protokoll/Port).
// In Produktion z. B. "orange-bar.example.com".
export const RP_ID = process.env.ORANGE_RP_ID || 'localhost';
export const RP_NAME = process.env.ORANGE_RP_NAME || 'Orange-Bar';

// Erwartete Origin(s) für WebAuthn-Antworten. Kommagetrennt für mehrere.
export const ORIGINS = (process.env.ORANGE_ORIGINS || `http://localhost:${PORT}`)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const config = {
  port: PORT,
  rpId: RP_ID,
  rpName: RP_NAME,
  origins: ORIGINS,

  // Verfügbare IOTA-Netzwerke; Nutzer können in der App umschalten.
  iotaNetworks: ['testnet', 'devnet', 'mainnet'],
  // Standard-Netzwerk für neue Nutzer.
  iotaNetwork: process.env.ORANGE_IOTA_NETWORK || 'testnet',
  // Optionale eigene RPC-Endpunkte je Netzwerk, z. B.
  // ORANGE_IOTA_RPC_TESTNET=https://…  ORANGE_IOTA_RPC_MAINNET=https://…
  iotaRpcUrls: {
    testnet: process.env.ORANGE_IOTA_RPC_TESTNET || process.env.ORANGE_IOTA_RPC_URL || '',
    devnet: process.env.ORANGE_IOTA_RPC_DEVNET || '',
    mainnet: process.env.ORANGE_IOTA_RPC_MAINNET || '',
  },

  // Nutzernamen, die zusätzlich Admin-Rechte bekommen (kommagetrennt).
  // Unabhängig davon wird der allererste registrierte Nutzer Admin.
  adminUsers: (process.env.ORANGE_ADMIN_USERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Pfad zur SQLite-Datenbank.
  dbPath: process.env.ORANGE_DB_PATH || new URL('../data/orange-bar.db', import.meta.url).pathname,

  // Master-Key (hex, 32 Byte) zur Verschlüsselung der Wallet-Schlüssel.
  // Ohne Angabe wird beim ersten Start einer erzeugt und in data/ abgelegt.
  masterKeyHex: process.env.ORANGE_MASTER_KEY || '',

  // Session-Laufzeit in Sekunden (Standard: 7 Tage).
  sessionTtlSeconds: Number(process.env.ORANGE_SESSION_TTL || 7 * 24 * 3600),

  // Wie lange eine vorbereitete Transaktion auf ihre Passkey-Bestätigung
  // warten darf, bevor sie verfällt (Sekunden).
  txChallengeTtlSeconds: Number(process.env.ORANGE_TX_TTL || 120),
};
