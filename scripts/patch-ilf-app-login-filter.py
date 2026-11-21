#!/usr/bin/env python3
"""Nur ILF Shop-Link-URLs in app_login speichern (Mintly-API nicht als ILF behandeln)."""
from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/www/orange-bar/public/app.js")
text = path.read_text(encoding="utf-8")

helper = """
function isIlfShopLinkApi(apiUrl) {
  try {
    return /\\/api\\/shop\\/orange-bar\\/link\\/[A-Za-z0-9_-]+$/.test(new URL(String(apiUrl)).pathname);
  } catch {
    return false;
  }
}

function dropStaleNonIlfShopLink() {
  const pending = readIlfShopLinkPending();
  if (pending?.api && !isIlfShopLinkApi(pending.api)) clearIlfShopLinkPending();
}

"""

if "function isIlfShopLinkApi" not in text:
    text = text.replace("function stashAppLoginFromUrl() {", helper + "function stashAppLoginFromUrl() {")

old = "  if (!apiUrl || !ret) return;\n  writeIlfShopLinkPending({ api: apiUrl, return: ret });"
new = "  if (!apiUrl || !ret) return;\n  if (!isIlfShopLinkApi(apiUrl)) return;\n  writeIlfShopLinkPending({ api: apiUrl, return: ret });"
if old in text:
    text = text.replace(old, new, 1)
else:
    print("stashAppLoginFromUrl block not found", file=sys.stderr)
    sys.exit(1)

old2 = "async function maybeHandleAppLogin() {\n  stashAppLoginFromUrl();\n  const pending = readIlfShopLinkPending();\n  if (!pending?.api) return;"
new2 = "async function maybeHandleAppLogin() {\n  dropStaleNonIlfShopLink();\n  stashAppLoginFromUrl();\n  const pending = readIlfShopLinkPending();\n  if (!pending?.api || !isIlfShopLinkApi(pending.api)) {\n    show($('#ilf-link-banner'), false);\n    return;\n  }"
if old2 in text:
    text = text.replace(old2, new2, 1)
else:
    print("maybeHandleAppLogin block not found", file=sys.stderr)
    sys.exit(1)

path.write_text(text, encoding="utf-8")
print("patched", path)