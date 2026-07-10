// Rechtstexte für Self-Hoster: Impressum, Datenschutz, AGB – aus ORANGE_LEGAL_*-Env.
// Siehe docs/LEGAL.md für Pflichtfelder und Beispiele.
import { config } from './config.js';

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lines(...parts) {
  return parts.filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n');
}

/** Liest und normalisiert alle ORANGE_LEGAL_*-Variablen. */
export function loadLegalConfig() {
  const name = (process.env.ORANGE_LEGAL_NAME || '').trim();
  const email = (process.env.ORANGE_LEGAL_EMAIL || '').trim();
  const street = (process.env.ORANGE_LEGAL_STREET || '').trim();
  const zip = (process.env.ORANGE_LEGAL_ZIP || '').trim();
  const city = (process.env.ORANGE_LEGAL_CITY || '').trim();
  const country = (process.env.ORANGE_LEGAL_COUNTRY || 'Deutschland').trim();
  const legal = {
    name,
    form: (process.env.ORANGE_LEGAL_FORM || '').trim(),
    street,
    zip,
    city,
    country,
    email,
    phone: (process.env.ORANGE_LEGAL_PHONE || '').trim(),
    website: (process.env.ORANGE_LEGAL_WEBSITE || '').trim(),
    register: (process.env.ORANGE_LEGAL_REGISTER || '').trim(),
    registerCourt: (process.env.ORANGE_LEGAL_REGISTER_COURT || '').trim(),
    vatId: (process.env.ORANGE_LEGAL_VAT_ID || '').trim(),
    responsible: (process.env.ORANGE_LEGAL_RESPONSIBLE || name).trim(),
    dpoEmail: (process.env.ORANGE_LEGAL_DPO_EMAIL || '').trim(),
    serviceName: (process.env.ORANGE_LEGAL_SERVICE_NAME || config.rpName).trim(),
    custodyNote: (process.env.ORANGE_LEGAL_CUSTODY_NOTE || '').trim(),
    walletMode: config.walletMode,
    custodialMode: config.custodialMode,
    rpId: config.rpId,
    configured: !!(name && email && street && city),
  };
  legal.displayName = legal.form ? `${legal.name} (${legal.form})` : legal.name;
  legal.addressBlock = [street, `${zip} ${city}`.trim(), country].filter(Boolean).join(', ');
  return legal;
}

function legalShell(title, bodyHtml, legal) {
  const warn = legal.configured ? '' : `
    <div class="legal-warn" role="alert">
      <strong>Hinweis für den Betreiber:</strong> Rechtstexte sind noch nicht konfiguriert.
      Setze die Umgebungsvariablen <code>ORANGE_LEGAL_*</code> (siehe
      <a href="https://github.com/lohegrimmig/Orange-Bar/blob/main/docs/LEGAL.md">docs/LEGAL.md</a>)
      und starte den Server neu.
    </div>`;
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)} – ${esc(legal.serviceName)}</title>
  <link rel="stylesheet" href="/style.css" />
  <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
</head>
<body>
  <div class="bg-mesh" aria-hidden="true"></div>
  <header class="topbar">
    <a href="/" class="brand" style="text-decoration:none;color:inherit"><span class="brand-bar"></span> ${esc(legal.serviceName)}</a>
  </header>
  <main class="legal-page">
    ${warn}
    <article class="card glass legal-card">
      <h1>${esc(title)}</h1>
      ${bodyHtml}
      <nav class="legal-nav muted small">
        <a href="/legal/impressum">Impressum</a> ·
        <a href="/legal/datenschutz">Datenschutz</a> ·
        <a href="/legal/agb">AGB</a> ·
        <a href="/">Zur Wallet</a>
      </nav>
    </article>
  </main>
</body>
</html>`;
}

export function renderImpressumHtml() {
  const legal = loadLegalConfig();
  if (!legal.configured) {
    return legalShell('Impressum', `
      <p class="muted">Platzhalter – bitte vom Betreiber dieser Instanz ausfüllen.</p>
      <h2>Erforderliche Umgebungsvariablen</h2>
      <ul>
        <li><code>ORANGE_LEGAL_NAME</code> – Name des Diensteanbieters</li>
        <li><code>ORANGE_LEGAL_EMAIL</code> – Kontakt-E-Mail</li>
        <li><code>ORANGE_LEGAL_STREET</code>, <code>ORANGE_LEGAL_ZIP</code>, <code>ORANGE_LEGAL_CITY</code></li>
      </ul>
      <p>Vollständige Anleitung: <code>docs/LEGAL.md</code> im Repository.</p>
    `, legal);
  }

  const walletNote = legal.custodialMode
    ? (legal.custodyNote || 'Diese Instanz betreibt Orange-Bar im Custodial-Modus: Nutzer-Schlüssel werden verschlüsselt auf dem Server gehalten. In der EU kann MiCA-CASP-Pflicht gelten.')
    : 'Diese Instanz betreibt Orange-Bar im Non-Custodial-Modus: private Schlüssel der Nutzer werden nicht vom Betreiber verwahrt; Transaktionen werden auf dem Gerät des Nutzers signiert.';

  const body = `
    <h2>Angaben gemäß § 5 DDG</h2>
    ${lines(legal.displayName)}
    <p>${esc(legal.street)}<br>${esc(legal.zip)} ${esc(legal.city)}<br>${esc(legal.country)}</p>
    <h2>Kontakt</h2>
    ${lines(`E-Mail: ${legal.email}`, legal.phone ? `Telefon: ${legal.phone}` : null, legal.website ? `Web: ${legal.website}` : null)}
    ${legal.register ? `<h2>Registereintrag</h2>${lines(legal.register, legal.registerCourt ? `Registergericht: ${legal.registerCourt}` : null)}` : ''}
    ${legal.vatId ? `<h2>Umsatzsteuer-ID</h2>${lines(`USt-IdNr.: ${legal.vatId}`)}` : ''}
    <h2>Verantwortlich für den Inhalt</h2>
    ${lines(legal.responsible)}
    <h2>Dienstbeschreibung</h2>
    <p><strong>${esc(legal.serviceName)}</strong> wird unter <code>${esc(legal.rpId)}</code> bereitgestellt.
    Wallet-Modus: <strong>${esc(legal.walletMode)}</strong>.</p>
    <p>${esc(walletNote)}</p>
    <p class="muted small">Orange-Bar ist Open-Source-Software; Verantwortlicher Diensteanbieter ist der Betreiber dieser Instanz, nicht automatisch die Software-Autoren.</p>
  `;
  return legalShell('Impressum', body, legal);
}

export function renderPrivacyHtml() {
  const legal = loadLegalConfig();
  if (!legal.configured) {
    return legalShell('Datenschutzerklärung', `
      <p class="muted">Platzhalter – konfiguriere <code>ORANGE_LEGAL_*</code> und passe diesen Text ggf. mit Rechtsberatung an.</p>
    `, legal);
  }

  const custody = legal.custodialMode
    ? `<li><strong>Wallet-Schlüssel (Custodial):</strong> verschlüsselte Schlüsselmaterialien auf dem Server – der Betreiber kann technisch signieren, sofern der Nutzer per Passkey bestätigt.</li>`
    : `<li><strong>Wallet (Non-Custodial):</strong> der Server speichert keine Klartext-Schlüssel; nur verschlüsselte PRF-gebundene Daten und die öffentliche Adresse.</li>`;

  const body = `
    <p>Verantwortlicher i.S.d. Art. 4 Nr. 7 DSGVO:</p>
    ${lines(legal.displayName, legal.addressBlock, `E-Mail: ${legal.email}`)}
    ${legal.dpoEmail ? `<p>Datenschutzbeauftragter: <a href="mailto:${esc(legal.dpoEmail)}">${esc(legal.dpoEmail)}</a></p>` : ''}
    <h2>1. Welche Daten wir verarbeiten</h2>
    <ul>
      <li>Nutzername, Passkey-Metadaten (öffentlicher Schlüssel, Credential-ID), Session-Cookies</li>
      <li>Wallet-Adresse, Netzwerkwahl, optional 2FA-Secret (verschlüsselt)</li>
      <li>Transaktions-Metadaten und Aktivitätsanzeige (On-Chain-Daten sind öffentlich)</li>
      <li>Push-Abonnements (falls aktiviert), Barkeeper-Projektdaten</li>
      ${custody}
    </ul>
    <h2>2. Zwecke & Rechtsgrundlagen</h2>
    <p>Bereitstellung der Wallet, Authentifizierung, Zahlungs- und Verifizierungs-Flows
    (Art. 6 Abs. 1 lit. b DSGVO Vertrag / vorvertragliche Maßnahmen; lit. f berechtigtes Interesse an Betrieb und Sicherheit).</p>
    <h2>3. Speicherdauer</h2>
    <p>Bis zur Löschung des Kontos durch den Nutzer bzw. den Betreiber; Sessions und Challenges werden automatisch bereinigt.</p>
    <h2>4. Ihre Rechte</h2>
    <p>Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit, Widerspruch – Kontakt: ${esc(legal.email)}.
    Beschwerderecht bei einer Aufsichtsbehörde.</p>
    <p class="muted small">Diese Vorlage ersetzt keine individuelle Rechtsberatung. Passe sie an dein tatsächliches Hosting an.</p>
  `;
  return legalShell('Datenschutzerklärung', body, legal);
}

export function renderTermsHtml() {
  const legal = loadLegalConfig();
  if (!legal.configured) {
    return legalShell('Nutzungsbedingungen (AGB)', `
      <p class="muted">Platzhalter – konfiguriere <code>ORANGE_LEGAL_*</code> und passe die AGB mit Rechtsberatung an.</p>
    `, legal);
  }

  const risk = legal.custodialMode
    ? 'Im Custodial-Modus verwahrt der Betreiber verschlüsselte Schlüssel. Es besteht Restrisiko bei Serverangriffen; keine Garantie für Verfügbarkeit oder Werterhalt.'
    : 'Im Non-Custodial-Modus trägst du die Verantwortung für Passkey und Gerät. Verlust kann zum unwiederbringlichen Verlust von Guthaben führen.';

  const body = `
    <p>Anbieter: ${esc(legal.displayName)} · ${esc(legal.addressBlock)}</p>
    <h2>1. Geltungsbereich</h2>
    <p>Diese Bedingungen gelten für die Nutzung von <strong>${esc(legal.serviceName)}</strong> unter ${esc(legal.rpId)}.</p>
    <h2>2. Leistung</h2>
    <p>Software-Wallet für IOTA und NFTs, In-Game-Zahlungen über das SDK. Modus: <strong>${esc(legal.walletMode)}</strong>.</p>
    <h2>3. Nutzerpflichten</h2>
    <p>Keine illegalen Transaktionen; nur Beträge einsetzen, deren Verlust du verkraften kannst; Passkey sicher aufbewahren.</p>
    <h2>4. Haftung & Risiko</h2>
    <p>${esc(risk)} Keine Anlageberatung. Software „wie besehen“ – siehe Open-Source-Lizenz im Repository.</p>
    <h2>5. Kontakt</h2>
    <p>${esc(legal.email)}</p>
    <p class="muted small">Kurz-AGB-Vorlage – für Produktion mit Anwalt vervollständigen.</p>
  `;
  return legalShell('Nutzungsbedingungen (AGB)', body, legal);
}

/** Öffentliche Zusammenfassung für Footer/API (ohne interne Details). */
export function publicLegalSummary() {
  const legal = loadLegalConfig();
  return {
    configured: legal.configured,
    serviceName: legal.serviceName,
    operatorName: legal.displayName,
    email: legal.email,
    links: {
      impressum: '/legal/impressum',
      privacy: '/legal/datenschutz',
      terms: '/legal/agb',
    },
  };
}
