#!/usr/bin/env python3
"""Fügt signPersonalMessageForUser in eine ältere server/wallet.js ein."""
from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/www/orange-bar/server/wallet.js")
text = path.read_text(encoding="utf-8")
if "signPersonalMessageForUser" in text:
    print("already has signPersonalMessageForUser")
    raise SystemExit(0)

block = """
/** Ed25519-Signatur über eine Personal Message (Mintly-Login-Challenge o. Ä.). */
export async function signPersonalMessageForUser(userId, message) {
  const keypair = loadKeypair(userId);
  if (!keypair) throw new Error('Kein Wallet vorhanden.');
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const { signature } = await keypair.signPersonalMessage(bytes);
  return { address: keypair.getPublicKey().toIotaAddress(), signature };
}

"""

needle = "export async function signOwnerPersonalMessage"
idx = text.find(needle)
if idx < 0:
    raise SystemExit("signOwnerPersonalMessage not found")
path.write_text(text[:idx] + block + text[idx:], encoding="utf-8")
print("patched", path)