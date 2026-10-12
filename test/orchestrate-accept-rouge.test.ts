import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkRouges } from '../src/orchestrate/accept.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { ecritAcceptation } from './accept-helpers.js';
import { acceptReport, claudeOut, commitFile, harness, reviewReport, rougesDe, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

// L204 : les tests d'acceptation sont validés dès leur écriture — chacun rouge pour la BONNE raison (la fonctionnalité manque), jamais à cause du test.
const R = (test: string, over: Record<string, unknown> = {}) => ({ test, echec: 'expect(locator).toBeVisible() — element(s) not found', cause: 'absent', ...over });
const PLAN = ['R1 — a', 'R2 — b'];

describe('checkRouges : le contrôle pur', () => {
  it('une entrée par test prévu, cause « absent », échec lisible : rien à signaler', () => {
    expect(checkRouges(PLAN.map((t) => R(t)), PLAN, [])).toEqual([]);
  });

  it('un test prévu sans entrée est nommé', () => {
    const p = checkRouges([R(PLAN[0])], PLAN, []);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('R2 — b');
  });

  it('une cause « autre » (regex trop large, route non simulée, variable capturée, délai, e2e en unitaire) renvoie à la session', () => {
    const p = checkRouges([R(PLAN[0]), R(PLAN[1], { cause: 'autre' })], PLAN, []);
    expect(p.join('\n')).toMatch(/R2 — b.*autre raison que la fonctionnalité absente/);
  });

  it('un ReferenceError dont la première frame est dans le fichier de test est refusé', () => {
    for (const echec of [
      'ReferenceError: lastY is not defined\n    at test/scroll.test.ts:12:5',
      'ReferenceError: lastY is not defined\n    at Object.<anonymous> (/repo/e2e/scroll.spec.ts:12:5)\n    at /repo/src/app.ts:3:1',
    ]) {
      expect(checkRouges([R(PLAN[0], { echec }), R(PLAN[1])], PLAN, [], ['e2e/scroll.spec.ts']).join('\n'), echec).toContain('R1 — a');
    }
  });

  it('un ReferenceError levé dans le code que le test fait évaluer au navigateur (page.evaluate : frames anonymes, puis le test) est refusé', () => {
    const echec = [
      'page.evaluate: ReferenceError: scrollY2 is not defined',
      '    at eval (eval at evaluate (:311:30), <anonymous>:1:7)',
      '    at UtilityScript.evaluate (<anonymous>:313:16)',
      '    at UtilityScript.<anonymous> (<anonymous>:1:44)',
      '    at /repo/e2e/galerie-filtres-l49.acceptation.spec.mjs:20:20',
    ].join('\n');
    expect(checkRouges([R(PLAN[0], { echec }), R(PLAN[1])], PLAN, [], []).join('\n')).toContain('R1 — a');
  });

  it('un ReferenceError sans aucune frame lisible n’est pas classé : accepté', () => {
    const echec = 'ReferenceError: formatDate is not defined';
    expect(checkRouges(PLAN.map((t) => R(t, { echec })), PLAN, [], ['e2e/a.spec.ts'])).toEqual([]);
  });

  it('les fichiers de l’acceptation : une frame relative à la racine de la commande (cd frontend &&) est reconnue, une frame d’un autre fichier non', () => {
    const at = (f: string) => `ReferenceError: x is not defined\n    ❯ ${f}:1:61`;
    const fichiers = ['frontend/acceptance/galerie.ts'];
    expect(checkRouges([R(PLAN[0], { echec: at('acceptance/galerie.ts') }), R(PLAN[1])], PLAN, [], fichiers).join('\n')).toContain('R1 — a');
    expect(checkRouges([R(PLAN[0], { echec: at('/repo/frontend/acceptance/galerie.ts') }), R(PLAN[1])], PLAN, [], fichiers).join('\n')).toContain('R1 — a');
    expect(checkRouges(PLAN.map((t) => R(t, { echec: at('src/galerie.ts') })), PLAN, [], fichiers)).toEqual([]);
  });

  it('un ReferenceError levé par le code de l’application (première frame hors du test) est la fonctionnalité absente : accepté', () => {
    const echec = 'ReferenceError: formatDate is not defined\n    at render (/repo/src/pages/home.ts:8:3)\n    at test/home.test.ts:5:1';
    expect(checkRouges(PLAN.map((t) => R(t, { echec })), PLAN, [], [])).toEqual([]);
  });

  it('un échec à l’import (module à créer, export à ajouter, SyntaxError d’import ESM) est la fonctionnalité absente : accepté', () => {
    for (const echec of [
      "Cannot find module './cache.service' from 'test/cache.spec.ts'",
      'Failed to resolve import "./cache.service" from "test/cache.spec.ts"',
      "SyntaxError: The requested module '../src/cache.js' does not provide an export named 'Cache'",
      'SyntaxError: Named export \'Cache\' not found.',
      'Error: No known export "Cache" in test/cache.spec.ts',
    ]) {
      expect(checkRouges(PLAN.map((t) => R(t, { echec })), PLAN, []), echec).toEqual([]);
    }
  });

  it('un échec vide est refusé', () => {
    expect(checkRouges([R(PLAN[0], { echec: '  ' }), R(PLAN[1])], PLAN, [])[0]).toContain('R1 — a');
  });

  it('une sortie « aucun test trouvé » est un rouge sans test : refusée, avec la commande', () => {
    for (const out of ['No test files found, exiting with code 1', 'No tests found, exiting with code 1']) {
      expect(checkRouges(PLAN.map((t) => R(t)), PLAN, [{ command: 'npx vitest run', output: out }])[0], out).toContain('npx vitest run');
    }
  });
});

const lots = [{ title: 'Un écran', screen: 'page' as const }];
const screen = { visible: true, screen: 'page' as const };
const config = { accept: 'test -f done.flag', test: 'true' };
const ok: Handler = () => claudeOut(reviewReport());
const green: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }));
const accept = (over: (repo: string) => Record<string, unknown>): Handler => (call) => {
  ecritAcceptation(call.opts.cwd, { sansFiche: true });
  return claudeOut(acceptReport(over(call.opts.cwd), call.opts.cwd));
};
const prepared = (script: NonNullable<Parameters<typeof harness>[0]>['script']) => {
  const h = harness({ lots, script });
  ecrit(h.repo);
  return h;
};

describe('étape accept : la validation des rouges dans le cycle', () => {
  it('rapport conforme : l’étape passe au scellé', async () => {
    const h = prepared({ accept: [accept(() => ({}))], implement: [green], review: [ok] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.accept?.rouge).toMatch(/^[0-9a-f]{40}$/);
  });

  it('un rapport sans « rouges » est un rapport mal formé', async () => {
    const h = prepared({ accept: [(call) => { ecritAcceptation(call.opts.cwd, { sansFiche: true }); const { rouges, ...sans } = acceptReport(); void rouges; return claudeOut(sans); }] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).not.toBe('ready');
    expect(c.lot.accept).toBeUndefined();
  });

  it('un test rouge pour une mauvaise raison renvoie à la session accept AVANT le scellé, puis passe à la seconde', async () => {
    const bad = (repo: string) => ({ rouges: rougesDe(repo).map((r, i) => (i === 0 ? { ...r, cause: 'autre', echec: 'ReferenceError: x is not defined\n    at test/x.test.ts:1:1' } : r)) });
    const h = prepared({ accept: [accept(bad), accept(() => ({}))], implement: [green], review: [ok] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(h.calls.map((x) => x.kind).slice(0, 2)).toEqual(['accept', 'accept']);
    expect(h.calls[1].brief).toContain('R1 —');
    expect(c.lot.accept?.rouge).toMatch(/^[0-9a-f]{40}$/);
  });

  it('toujours une mauvaise raison à la seconde passe : le lot est rendu, rien n’est scellé', async () => {
    const bad = (repo: string) => ({ rouges: rougesDe(repo).slice(1) });
    const h = prepared({ accept: [accept(bad), accept(bad)] });
    const c = h.lot('L1', screen, config);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/accept non conforme après 2 passes/);
    expect(c.lot.accept).toBeUndefined();
  });

  it('une commande dédiée qui échoue faute de tests trouvés n’est pas un rouge valide', async () => {
    const h = prepared({ accept: [accept(() => ({})), accept(() => ({}))] });
    const c = h.lot('L1', screen, { ...config, accept: 'echo "No test files found, exiting with code 1"; exit 1' });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/No test files found|aucun test/i);
  });
});

describe('étape accept : le brief et l’agent demandent le rouge pour la bonne raison', () => {
  it.each(['accept.md', 'accept-back.md'])('%s demande, par test, l’échec observé et sa cause', (f) => {
    const t = readFileSync(new URL(`../templates/orchestrate/${f}`, import.meta.url), 'utf8');
    for (const mot of ['rouges', 'echec', 'cause', 'absent', 'autre', 'regex', 'route', 'e2e']) expect(t, mot).toContain(mot);
  });

  it('l’agent acceptance-writer lit chaque échec avant de commiter', () => {
    const a = readAgents(AGENTS_DIR)['acceptance-writer'];
    expect(a.prompt).toMatch(/rouges/);
    expect(a.prompt).toMatch(/regex/);
  });
});
