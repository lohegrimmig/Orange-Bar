// Öffentliche Rechtsseiten (Impressum, Datenschutz, AGB) – Inhalt aus ORANGE_LEGAL_*.
import { Router } from 'express';
import {
  publicLegalSummary,
  renderImpressumHtml,
  renderPrivacyHtml,
  renderTermsHtml,
} from '../legal.js';

export const legalRouter = Router();

legalRouter.get('/api/legal', (_req, res) => {
  res.json(publicLegalSummary());
});

legalRouter.get('/legal/impressum', (_req, res) => {
  res.type('html').send(renderImpressumHtml());
});

legalRouter.get('/legal/datenschutz', (_req, res) => {
  res.type('html').send(renderPrivacyHtml());
});

legalRouter.get('/legal/agb', (_req, res) => {
  res.type('html').send(renderTermsHtml());
});
