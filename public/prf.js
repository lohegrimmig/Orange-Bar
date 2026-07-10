// WebAuthn-PRF: leitet aus einem Passkey ein stabiles Geheimnis ab und
// ver-/entschlüsselt damit den Wallet-Seed (AES-256-GCM). Das Geheimnis
// verlässt nie das Gerät; der Server speichert nur den verschlüsselten Seed.
//
// Voraussetzung: Authenticator/Browser mit PRF-Erweiterung (hmac-secret).
// Ist sie nicht verfügbar, liefert getPrfOutput() null → Self-Custody bleibt aus.

const b64uToBuf = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Fester PRF-Eval-Salt (die PRF-Ausgabe ist ohnehin je Passkey verschieden).
export const PRF_SALT = new TextEncoder().encode('orange-bar/self-custody/v1');

/**
 * Holt die PRF-Ausgabe (32 Byte Geheimnis) für einen Passkey.
 * @param {string[]} [allowCredentialIds] erlaubte Credential-IDs (base64url); leer = alle
 * @returns {Promise<{prf: Uint8Array, credentialId: string}|null>}
 *   null, wenn PRF nicht unterstützt wird
 */
export async function getPrfOutput(allowCredentialIds = []) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: (allowCredentialIds || []).map((id) => ({ id: b64uToBuf(id), type: 'public-key' })),
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  const res = assertion.getClientExtensionResults?.();
  const first = res?.prf?.results?.first;
  if (!first) return null;
  return { prf: new Uint8Array(first), credentialId: bufToB64u(assertion.rawId) };
}

/** Leitet aus der PRF-Ausgabe einen stabilen 32-Byte-Ed25519-Seed ab. */
export async function deriveSeedFromPrf(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('orange-bar/wallet-seed/v1') },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** Prüft grob, ob PRF grundsätzlich verfügbar sein könnte (Feature-Detection). */
export function prfMaybeSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

async function aesKeyFromPrf(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('orange-bar-aes') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/** Verschlüsselt den Seed mit dem PRF-abgeleiteten Schlüssel → base64(iv||ct). */
export async function wrapSeed(seed, prf) {
  const key = await aesKeyFromPrf(prf);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, seed));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

/** Entschlüsselt base64(iv||ct) mit dem PRF-abgeleiteten Schlüssel → Seed. */
export async function unwrapSeed(wrappedB64, prf) {
  const raw = b64ToBytes(wrappedB64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = await aesKeyFromPrf(prf);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
