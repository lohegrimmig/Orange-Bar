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
    /**
     * @param {string} baseUrl  URL deiner Orange-Bar-Instanz.
     * @param {object} [opts]
     * @param {string} [opts.projectId]  Optionale Barkeeper-Projekt-ID. Bindet
     *   Zahlungen an dein Projekt (Origin-Allowlist als Schutz) und ermöglicht,
     *   dass Spieler Gas aus deiner Projekt-Station beziehen.
     */
    constructor(baseUrl, opts = {}) {
      this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
      if (!this.baseUrl) throw new Error('OrangeBar: baseUrl fehlt.');
      this.projectId = opts.projectId || null;
    }

    /** Legt serverseitig eine Zahlungsanfrage an und liefert ihre ID. */
    async createRequest({ to, amountNanos, amountIota, memo }) {
      const res = await fetch(`${this.baseUrl}/api/pay/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to, amountNanos: toNanos({ amountNanos, amountIota }), memo,
          projectId: this.projectId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
      return data.id;
    }

    /** Fragt den Status einer Zahlungsanfrage ab. */
    async getStatus(id) {
      const r = await fetch(`${this.baseUrl}/api/pay/request/${encodeURIComponent(id)}`);
      const s = await r.json();
      return { status: s.status, digest: s.txDigest || undefined };
    }

    /**
     * Fordert eine Zahlung an. Der Nutzer bestätigt in Orange-Bar per Passkey.
     * @param {object} opts
     * @param {'auto'|'popup'|'redirect'} [opts.mode='auto']
     *   - 'popup'    : Orange-Bar öffnet sich in einem Fenster (Desktop).
     *   - 'redirect' : Die aktuelle Seite navigiert zu Orange-Bar und kehrt danach
     *                  mit ?ob_pay=<id>&ob_status=… zurück (robust auf Mobil/In-App).
     *   - 'auto'     : Popup, mit automatischem Redirect-Fallback bei Blockade.
     * @param {string} [opts.returnUrl] Rückkehrziel im Redirect-Modus (Standard: aktuelle URL).
     * @returns {Promise<{status: 'confirmed'|'rejected'|'expired'|'closed', digest?: string}>}
     *   (im Redirect-Modus kehrt die Funktion nicht zurück – siehe checkReturn()).
     */
    async requestPayment(opts) {
      const { mode = 'auto', returnUrl } = opts;
      const id = await this.createRequest(opts);

      if (mode === 'redirect') return this._redirect(id, returnUrl);

      const popup = window.open(
        `${this.baseUrl}/?pay=${encodeURIComponent(id)}`,
        'orange-bar-pay',
        'width=430,height=740,menubar=no,toolbar=no'
      );
      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        if (mode === 'popup') throw new Error('Popup wurde blockiert – bitte Popups erlauben.');
        return this._redirect(id, returnUrl); // auto: Fallback
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('message', onMessage);
          clearInterval(poll);
          resolve(result);
        };
        const onMessage = (ev) => {
          if (ev.origin !== this.baseUrl) return;
          if (ev.data && ev.data.type === 'orange-bar:payment') {
            finish({ status: ev.data.status, digest: ev.data.digest });
          }
        };
        window.addEventListener('message', onMessage);
        const poll = setInterval(async () => {
          try {
            const s = await this.getStatus(id);
            if (s.status && s.status !== 'pending') finish(s);
            else if (popup.closed) finish({ status: 'closed' });
          } catch { /* weiter versuchen */ }
        }, 1500);
      });
    }

    _redirect(id, returnUrl) {
      const back = encodeURIComponent(returnUrl || window.location.href);
      window.location.href = `${this.baseUrl}/?pay=${encodeURIComponent(id)}&return=${back}`;
      return new Promise(() => {}); // Navigation läuft; Ergebnis via checkReturn()
    }

    /**
     * Beim Zurückkehren aus dem Redirect-Modus aufrufen (z. B. beim Laden der
     * Spielseite). Liest ?ob_pay & ?ob_status aus der URL, holt bei Bedarf den
     * finalen Status nach und räumt die URL auf.
     * @returns {Promise<null|{id, status, digest?}>}
     */
    async checkReturn() {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('ob_pay');
      if (!id) return null;
      let result;
      try { result = await this.getStatus(id); }
      catch { result = { status: params.get('ob_status') || 'unknown' }; }
      // URL bereinigen, damit ein Reload nicht erneut auslöst.
      params.delete('ob_pay'); params.delete('ob_status');
      const clean = window.location.pathname + (params.toString() ? `?${params}` : '') + window.location.hash;
      window.history.replaceState({}, '', clean);
      return { id, ...result };
    }
  }

  global.OrangeBar = OrangeBar;
})(typeof window !== 'undefined' ? window : globalThis);
