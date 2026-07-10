// ORANGE_LEGAL_* – Impressum/Datenschutz-Konfiguration.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const saved = {};
for (const k of Object.keys(process.env)) {
  if (k.startsWith('ORANGE_LEGAL_')) saved[k] = process.env[k];
}

function clearLegalEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ORANGE_LEGAL_')) delete process.env[k];
  }
}

function restoreLegalEnv() {
  clearLegalEnv();
  Object.assign(process.env, saved);
}

describe('legal config', () => {
  before(() => { clearLegalEnv(); });
  after(() => { restoreLegalEnv(); });

  test('unconfigured when name missing', async () => {
    const { loadLegalConfig } = await import('../server/legal.js');
    const legal = loadLegalConfig();
    assert.equal(legal.configured, false);
  });

  test('configured with minimal fields', async () => {
    process.env.ORANGE_LEGAL_NAME = 'Test GmbH';
    process.env.ORANGE_LEGAL_EMAIL = 'a@b.de';
    process.env.ORANGE_LEGAL_STREET = 'Weg 1';
    process.env.ORANGE_LEGAL_CITY = 'Berlin';
    const { loadLegalConfig, renderImpressumHtml } = await import('../server/legal.js');
    const legal = loadLegalConfig();
    assert.equal(legal.configured, true);
    assert.equal(legal.displayName, 'Test GmbH');
    const html = renderImpressumHtml();
    assert.match(html, /Test GmbH/);
    assert.match(html, /a@b\.de/);
    assert.doesNotMatch(html, /Platzhalter – bitte vom Betreiber/);
  });

  test('form appended to display name', async () => {
    process.env.ORANGE_LEGAL_NAME = 'Beispiel AG';
    process.env.ORANGE_LEGAL_FORM = 'AG';
    process.env.ORANGE_LEGAL_EMAIL = 'x@y.de';
    process.env.ORANGE_LEGAL_STREET = 'S 1';
    process.env.ORANGE_LEGAL_CITY = 'Hamburg';
    const { loadLegalConfig } = await import('../server/legal.js');
    assert.equal(loadLegalConfig().displayName, 'Beispiel AG (AG)');
  });
});
