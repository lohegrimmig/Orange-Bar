// did:key für Ed25519 – die Off-Chain-Stufe der Identity-Architektur
// (docs/IDENTITY_ARCHITECTURE.md §4.2). Ein did:key ist deterministisch aus dem
// öffentlichen Schlüssel ableitbar und kostet kein Gas. Das Upgrade auf ein
// On-Chain-did:iota (Identity-Objekt auf IOTA Rebased) folgt, sobald das
// IOTA-Identity-Framework für Rebased stabil veröffentlicht ist – bis dahin
// bleibt diese Stufe die produktive Basis.
//
// Format: did:key:z<base58btc(0xed 0x01 || 32-Byte-Ed25519-Pubkey)>
// (Multicodec ed25519-pub = 0xed01, Multibase-Präfix 'z' = base58btc)

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

/** Base58btc-Encoding (BigInt-basiert; unsere Eingaben sind 34 Bytes). */
export function base58btcEncode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // führende Null-Bytes als '1' kodieren
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58btcDecode(str) {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET_MAP[c];
    if (v === undefined) throw new Error('Ungültiges Base58-Zeichen.');
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/** Leitet den did:key aus einem 32-Byte-Ed25519-Pubkey ab. */
export function didKeyFromPublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new Error('did:key erwartet einen 32-Byte-Ed25519-Pubkey.');
  }
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);
  return 'did:key:z' + base58btcEncode(prefixed);
}

/** Extrahiert den 32-Byte-Ed25519-Pubkey aus einem did:key. */
export function publicKeyFromDidKey(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) {
    throw new Error('Kein Ed25519-did:key.');
  }
  const bytes = base58btcDecode(did.slice('did:key:z'.length));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error('did:key ist kein Ed25519-Schlüssel.');
  }
  return bytes.slice(2);
}
