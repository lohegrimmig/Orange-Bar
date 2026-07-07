/**
 * Orange-Bar In-Game-SDK
 * ----------------------
 * Spiele binden dieses Skript ein und fordern Zahlungen an, ohne selbst
 * Wallet-Logik zu brauchen. Der Nutzer bestätigt in Orange-Bar per Passkey.
 *
 *   <script src="https://DEINE-ORANGE-BAR-DOMAIN/sdk/orange-bar-sdk.js"></script>
 *   <script>
 *     const ob = new OrangeBar('https://DEINE-ORANGE-BAR-DOMAIN');
 *     const result = await ob.requestPayment({
 *       to: '0x…',                 // Empfängeradresse des Spiels
 *       amountIota: '1.5',         // oder amountNanos: '1500000000'
 *       memo: 'Schwert des Feuers',
 *     });
 *     if (result.status === 'confirmed') { /* Item freischalten *\/ }
 *   </script>
 */
(function (global) {
  'use strict';

  const NANOS = 1000000000n;

  function toNanos({ amountNanos, amountIota }) {
    if (amountNanos != null) return BigInt(amountNanos).toString();
    const t = String(amountIota).trim().replace(',', '.');
    if (!/^\d+(\.\d{1,9})?$/.test(t)) throw new Error('Ungültiger IOTA-Betrag.');
    const [w, f = ''] = t.split('.');
    return (BigInt(w) * NANOS + BigInt(f.padEnd(9, '0'))).toString();
  }

  class OrangeBar {
    constructor(baseUrl) {
      this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
      if (!this.baseUrl) throw new Error('OrangeBar: baseUrl fehlt.');
    }

    /**
     * Fordert eine Zahlung an. Öffnet ein Orange-Bar-Fenster, in dem der
     * Nutzer per Passkey (Gesicht/Finger) bestätigt.
     * @returns {Promise<{status: 'confirmed'|'rejected'|'expired'|'closed', digest?: string}>}
     */
    async requestPayment({ to, amountNanos, amountIota, memo }) {
      const res = await fetch(`${this.baseUrl}/api/pay/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, amountNanos: toNanos({ amountNanos, amountIota }), memo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);

      const popup = window.open(
        `${this.baseUrl}/?pay=${encodeURIComponent(data.id)}`,
        'orange-bar-pay',
        'width=430,height=740,menubar=no,toolbar=no'
      );
      if (!popup) throw new Error('Popup wurde blockiert – bitte Popups für diese Seite erlauben.');

      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('message', onMessage);
          clearInterval(poll);
          resolve(result);
        };

        // Schneller Weg: Popup meldet die Bestätigung direkt zurück.
        const onMessage = (ev) => {
          if (ev.origin !== this.baseUrl) return;
          if (ev.data && ev.data.type === 'orange-bar:payment') {
            finish({ status: ev.data.status, digest: ev.data.digest });
          }
        };
        window.addEventListener('message', onMessage);

        // Robuster Weg: Status pollen (falls postMessage verloren geht
        // oder der Nutzer im selben Tab bestätigt).
        const poll = setInterval(async () => {
          try {
            const r = await fetch(`${this.baseUrl}/api/pay/request/${data.id}`);
            const s = await r.json();
            if (s.status && s.status !== 'pending') {
              finish({ status: s.status, digest: s.txDigest || undefined });
            } else if (popup.closed) {
              finish({ status: 'closed' });
            }
          } catch { /* Netzwerkfehler: weiter versuchen */ }
        }, 1500);
      });
    }
  }

  global.OrangeBar = OrangeBar;
})(typeof window !== 'undefined' ? window : globalThis);
