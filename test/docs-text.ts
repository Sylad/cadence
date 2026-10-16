import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const PAGES = ['raf', 'news', 'session', 'corrections', 'spec', 'deliver', 'orchestrate', 'skills', 'cadence-hud', 'releasing', 'stabilite', 'lead', 'overview', 'whats-new'];

/** La documentation d'usage de cadence : l'accueil (README.md) suivi des pages docs/ où part son contenu depuis L232. */
export function docText(): string {
  return [readFileSync(join(root, 'README.md'), 'utf8'), ...PAGES.map((p) => readFileSync(join(root, 'docs', `${p}.md`), 'utf8'))].join('\n');
}
