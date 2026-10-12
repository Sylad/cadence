import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { acceptCommands, isAcceptList, acceptRoot, acceptText, planAcceptRuns } from '../src/orchestrate/accept.js';
import { runLot } from '../src/orchestrate/cycle.js';
// @ts-expect-error gabarit .mjs livré tel quel, sans déclaration de types
import { acceptationOnly } from '../templates/acceptation-runner.mjs';
import { ecritAcceptation } from './accept-helpers.js';
import { acceptReport, claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { tempDir } from './helpers.js';

// L189 (spec etape-spec-back, B4) : orchestrate.accept en liste de lanceurs, racine par commande, filtre du gabarit, contrôle du rouge et du vert sur la liste.
const ok: Handler = () => claudeOut(reviewReport());
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const prepared = (script: NonNullable<Parameters<typeof harness>[0]>['script']) => {
  const h = harness({ lots, script });
  ecrit(h.repo);
  return h;
};

describe('liste de lanceurs : commandes et racines', () => {
  it('une chaîne reste une commande, une liste en garde l’ordre, absente = aucune', () => {
    expect(acceptCommands('npx vitest')).toEqual(['npx vitest']);
    expect(acceptCommands(['a', 'b'])).toEqual(['a', 'b']);
    expect(acceptCommands(undefined)).toEqual([]);
  });

  it('la racine d’une commande est le dossier de son cd initial, sinon le dépôt', () => {
    expect(acceptRoot('cd frontend && npx vitest run')).toBe('frontend');
    expect(acceptRoot('  cd ./backend/ && npx jest')).toBe('backend');
    expect(acceptRoot('cd "apps/web ui" && npx vitest')).toBe('apps/web ui');
    expect(acceptRoot("cd 'api' && x")).toBe('api');
    expect(acceptRoot('npx vitest run -c v.config.ts')).toBe('');
    expect(acceptRoot('echo cd frontend && x')).toBe('');
    expect(acceptRoot('cd .. && x')).toBe('');
  });

  it('une commande sans fichier sous sa racine n’est pas lancée, un fichier sous aucune racine est un orphelin', () => {
    const cmds = ['cd frontend && a', 'cd backend && b'];
    expect(planAcceptRuns(cmds, ['frontend/x.test.ts'])).toEqual({ runs: [{ command: 'cd frontend && a', root: 'frontend' }], orphans: [] });
    expect(planAcceptRuns(cmds, ['frontend/x.test.ts', 'docs/y.test.ts', 'frontendish/z.test.ts'])).toEqual({ runs: [{ command: 'cd frontend && a', root: 'frontend' }], orphans: ['docs/y.test.ts', 'frontendish/z.test.ts'] });
    expect(planAcceptRuns(['a'], ['frontend/x.test.ts', 'y.test.ts'])).toEqual({ runs: [{ command: 'a', root: '' }], orphans: [] });
  });

  it('une chaîne seule garde le dépôt pour racine, même avec un cd initial (comportement d’avant la liste)', () => {
    expect(planAcceptRuns(['cd frontend && a'], ['frontend/x.test.ts', 'y.test.ts'], true)).toEqual({ runs: [{ command: 'cd frontend && a', root: '' }], orphans: [] });
    expect(planAcceptRuns(['cd frontend && a'], ['y.test.ts'])).toEqual({ runs: [], orphans: ['y.test.ts'] });
  });

  it('le brief donne toutes les commandes et leur racine', () => {
    const t = acceptText({ fiche: 'f', maquette: 'm', acceptation: 'a.json', command: ['cd frontend && vt', 'cd backend && jest'] });
    expect(t).toContain('`cd frontend && vt`');
    expect(t).toContain('`cd backend && jest`');
    expect(t).toMatch(/only the files listed under its root/);
    expect(acceptText({ fiche: 'f', maquette: 'm', acceptation: 'a.json', command: 'vt' })).not.toMatch(/only the files listed under its root/);
  });
});

describe('liste de lanceurs : cadence.yaml', () => {
  const read = (yaml: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    return readOrchestrateConfig(join(dir, 'cadence.yaml'));
  };
  it('lit une liste de commandes, rognées', () => {
    expect(read('orchestrate:\n  accept:\n    - cd frontend && npx vitest run \n    - cd backend && npx jest\n').accept).toEqual(['cd frontend && npx vitest run', 'cd backend && npx jest']);
  });
  it('une chaîne reste une chaîne', () => {
    expect(read('orchestrate:\n  accept: npx vitest\n').accept).toBe('npx vitest');
  });
  it('refuse une liste vide ou un élément vide ou qui n’est pas une chaîne', () => {
    expect(() => read('orchestrate:\n  accept: []\n')).toThrow(/accept : commande non vide/);
    expect(() => read('orchestrate:\n  accept: [a, " "]\n')).toThrow(/accept : commande non vide/);
    expect(() => read('orchestrate:\n  accept: [a, 3]\n')).toThrow(/accept : commande non vide/);
  });
});

describe('liste de lanceurs : gabarit acceptation-runner.mjs', () => {
  const projet = () => {
    const root = tempDir();
    mkdirSync(join(root, 'docs/specs/p'), { recursive: true });
    const json = join(root, 'docs/specs/p/acceptation-L1.json');
    writeFileSync(json, JSON.stringify({ lot: 'L1', fiche: 'f', fichiers: ['frontend/src/a.test.ts', 'backend/src/b.test.ts', 'backend/src/c.test.ts', 'e2e/d.test.ts'], vert: false }));
    return json;
  };
  it('ne rend que les fichiers sous la racine du lanceur, relatifs à elle', () => {
    expect(acceptationOnly(projet(), 'backend')).toEqual(['src/b.test.ts', 'src/c.test.ts']);
    expect(acceptationOnly(projet(), './frontend/')).toEqual(['src/a.test.ts']);
  });
  it('sans racine : tous les fichiers, comme avant ; la racine vient de CADENCE_ACCEPTATION_ROOT', () => {
    expect(acceptationOnly(projet())).toHaveLength(4);
    process.env.CADENCE_ACCEPTATION_ROOT = 'backend';
    try {
      expect(acceptationOnly(projet())).toEqual(['src/b.test.ts', 'src/c.test.ts']);
    } finally {
      delete process.env.CADENCE_ACCEPTATION_ROOT;
    }
  });
});

describe('liste de lanceurs : le cycle', () => {
  const BACK = 'backend/b.test.ts';
  /** Tests rouges sous frontend/ (fichier principal) et backend/ : un fichier par racine. */
  const accept = (extra: string[] = [BACK]): Handler => (call) => {
    ecritAcceptation(call.opts.cwd, { sansFiche: true, racine: 'frontend', extra });
    return claudeOut(acceptReport());
  };
  const flag = (name: string, subject = 'feat(L1): a'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, name, subject)] }));
  const front = (flagFile: string) => `cd frontend && test -f ../${flagFile}`;
  const back = (flagFile: string) => `cd backend && test -f ../${flagFile}`;
  const vert = (h: { repo: string }) => JSON.parse(readFileSync(join(h.repo, 'docs/specs/prochain-match/acceptation-L1.json'), 'utf8')).vert;

  it('chaque lanceur reçoit CADENCE_ACCEPTATION et sa racine, le brief cite toutes les commandes', async () => {
    const h = prepared({ accept: [accept()], implement: [flag('done.flag')], review: [ok] });
    const log = join(tempDir(), 'env.log');
    const cmd = (root: string) => `cd ${root} && echo "${root}|$CADENCE_ACCEPTATION_ROOT|$CADENCE_ACCEPTATION" >> ${log}; test -f ../done.flag`;
    const c = h.lot('L1', screen, { accept: [cmd('frontend'), cmd('backend')], test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.filter((l) => l.startsWith('frontend|frontend|') && l.endsWith('acceptation-L1.json')).length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith('backend|backend|')).length).toBeGreaterThan(0);
    expect(h.calls[0].brief).toContain('cd frontend');
    expect(h.calls[0].brief).toContain('cd backend');
  });

  it('contrôle du rouge : une commande lancée qui passe est nommée comme écart, celle qui échoue non', async () => {
    const h = prepared({ accept: [accept(), accept()] });
    const c = h.lot('L1', screen, { accept: ['cd frontend && false', 'cd backend && true'], test: 'true' });
    await runLot(c);
    expect(h.calls[1].brief).toMatch(/cd backend && true.*passe alors que le code n'existe pas/);
    expect(h.calls[1].brief).not.toMatch(/cd frontend && false.*passe alors/);
    expect(c.lot.outcome).toMatch(/accept non conforme après 2 passes/);
  });

  it('une commande sans fichier listé sous sa racine n’est pas lancée : elle ne fait pas échouer le rouge, et le vert ne l’attend pas', async () => {
    const h = prepared({ accept: [accept([])], implement: [flag('done.flag')], review: [ok] });
    const c = h.lot('L1', screen, { accept: [front('done.flag'), 'cd backend && exit 3'], test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(vert(h)).toBe(true);
  });

  it('un fichier listé sous aucune racine est un écart, aux deux passes', async () => {
    const h = prepared({ accept: [accept(), accept()] });
    const c = h.lot('L1', screen, { accept: [front('done.flag'), 'cd e2e && false'], test: 'true' });
    await runLot(c);
    expect(h.calls[1].brief).toMatch(/sous la racine d'aucune commande de orchestrate\.accept.*backend\/b\.test\.ts/s);
    expect(c.lot.outcome).toMatch(/accept non conforme après 2 passes/);
  });

  it('retour au vert : vert: true seulement quand TOUTES les commandes lancées passent', async () => {
    const h = prepared({ accept: [accept()], implement: [flag('front.flag')], fix: [flag('back.flag', 'fix(L1): b')], review: [ok] });
    const c = h.lot('L1', screen, { accept: [front('front.flag'), back('back.flag')], test: 'true' });
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['accept', 'implement', 'fix', 'review']);
    expect(h.calls[2].brief).toContain('cd backend');
    expect(h.calls[2].brief).not.toMatch(/cd frontend && test.*encore rouges/);
    expect(vert(h)).toBe(true);
  });

  it('une chaîne unique garde son comportement (aucun cd : tous les fichiers sous la racine du dépôt)', async () => {
    const h = prepared({ accept: [accept()], implement: [flag('done.flag')], review: [ok] });
    const c = h.lot('L1', screen, { accept: 'test -f done.flag', test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(vert(h)).toBe(true);
  });

  it('une chaîne unique qui commence par un cd garde le dépôt pour racine : fichier hors du dossier accepté, CADENCE_ACCEPTATION_ROOT vaut « . »', async () => {
    const h = prepared({ accept: [accept()], implement: [flag('done.flag')], review: [ok] });
    const log = join(tempDir(), 'root.log');
    const c = h.lot('L1', screen, { accept: `cd frontend && echo "root=$CADENCE_ACCEPTATION_ROOT" >> ${log}; test -f ../done.flag`, test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(vert(h)).toBe(true);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(new Set(lines)).toEqual(new Set(['root=.']));
  });

  it('une liste d’un seul lanceur lance sous sa racine (pas comme une chaîne) : CADENCE_ACCEPTATION_ROOT vaut « frontend », un fichier hors de ce dossier est orphelin', async () => {
    const h = prepared({ accept: [accept([])], implement: [flag('done.flag')], review: [ok] });
    const log = join(tempDir(), 'root1.log');
    const c = h.lot('L1', screen, { accept: [`cd frontend && echo "root=$CADENCE_ACCEPTATION_ROOT" >> ${log}; test -f ../done.flag`], test: 'true' });
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(vert(h)).toBe(true);
    expect(new Set(readFileSync(log, 'utf8').trim().split('\n'))).toEqual(new Set(['root=frontend']));
  });

  it('une liste d’un seul lanceur : un fichier listé hors de sa racine est un écart (une chaîne seule le laisserait passer)', async () => {
    const h = prepared({ accept: [accept(), accept()] });
    const c = h.lot('L1', screen, { accept: [front('done.flag')], test: 'true' });
    await runLot(c);
    expect(h.calls[1].brief).toMatch(/sous la racine d'aucune commande de orchestrate\.accept.*backend\/b\.test\.ts/s);
  });
});

describe('liste de lanceurs : brief et cycle décident par la même fonction', () => {
  const cas: [string, string | string[], boolean][] = [
    ['une chaîne', 'cd frontend && vt', false],
    ['une liste de 1 élément', ['cd frontend && vt'], true],
    ['une liste de 2 éléments', ['cd frontend && vt', 'cd backend && jest'], true],
  ];
  it.each(cas)('%s : isAcceptList, planAcceptRuns et le brief concordent', (_nom, accept, liste) => {
    expect(isAcceptList(accept)).toBe(liste);
    const plan = planAcceptRuns(acceptCommands(accept), ['frontend/a.test.ts'], !isAcceptList(accept));
    expect(plan.runs[0].root).toBe(liste ? 'frontend' : '');
    const brief = acceptText({ fiche: 'f', maquette: 'm', acceptation: 'a.json', command: accept });
    expect(/only the files listed under its root/.test(brief)).toBe(liste);
  });
});

