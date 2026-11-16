// L748 : l'escalade Fable de cadence run (L726) compte aussi les revues mises en attente (.cadence/plan-en-attente.yaml, L695/L722) pendant qu'un
// autre programme tenait la branche. Vécu 16-11 sur L745 : la 2e revue non conforme, encore en attente au lancement du run de correction, n'a pas
// été vue ; deux revues non conformes ont compté pour une et la 3e passe a été jouée par Opus.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executerRun, type Etat } from '../src/run/run.js';
import { revueDuPlan, revuesEnAttente, revuesNonConformes, type Revue } from '../src/run/escalade.js';
import { PLAN_EN_ATTENTE } from '../../scripts/arbre-non-commite.mjs';
import { commite, depot, fauxClaude, io } from './run-outils.js';
import { dossierTemp } from './temp.js';

const relire = (e: Etat) => JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
function fauxRaf(revue?: Revue | null): string {
  const f = join(dossierTemp('raf-'), 'raf.mjs');
  const liste = JSON.stringify([{ id: 'L1', status: 'doing', ...(revue ? { review: revue } : {}) }]);
  writeFileSync(f, revue === null ? 'console.error("plan introuvable"); process.exit(1);\n' : `if (process.argv[2] === 'list') console.log(${JSON.stringify(liste)});\n`);
  return f;
}
/** Écrit le plan en attente comme src/repo-held.ts (deferPlanWrite) : en-tête, puis la liste { date, tenu, argv }. */
function attente(repo: string, ecritures: { date: string; argv: string[] }[] | string): void {
  mkdirSync(join(repo, '.cadence'), { recursive: true });
  writeFileSync(join(repo, PLAN_EN_ATTENTE), typeof ecritures === 'string' ? ecritures
    : `# Écritures du plan mises en attente\n${stringify(ecritures.map((w) => ({ ...w, tenu: 'cadence run 20261116-1 (L700)' })))}`);
}
// Midi UTC : le même jour en heure locale sous tout fuseau de -11 h à +11 h.
const NC1: Revue = { date: '2026-11-13', verdict: 'non conforme : test manquant', commit: 'aaa' };
const NC2_ARGV = ['review', 'L1', 'non conforme : doc muette', '--vu', 'bbb'];
const NC2_ATTENTE: Revue = { date: '2026-11-14', verdict: 'non conforme : doc muette', commit: 'bbb', en_attente: true };

describe('cadence run : revues mises en attente comptées pour l\'escalade (L748)', () => {
  let t = Date.parse('2026-11-14T12:00:00Z');
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const minute = () => vi.setSystemTime((t += 60_000));

  it('cas L745 : 2e revue non conforme encore en attente au lancement du run de correction → fable, et la raison dit « en attente »', () => {
    const repo = depot('exit 0'), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run = (raf: string, out = (_: string) => {}) => { minute(); return executerRun({ repo, demande: 'x', lot: 'L1', raf, exec: fauxClaude([commite(`f${appels.length}.txt`)], appels), out }); };
    expect(run(fauxRaf()).etat).toBe('integre'); // travail
    const b = run(fauxRaf(NC1)); // correction après NC1, appliquée au plan
    expect(relire(b)).toMatchObject({ etat: 'integre', modele: 'opus', revue: NC1 });
    // Le lead écrit NC2 pendant qu'un autre run tient main : raf la met en attente, le plan garde NC1.
    attente(repo, [{ date: '2026-11-14T12:00:00.000Z', argv: ['add', 'autre lot'] }, { date: '2026-11-14T12:00:00.000Z', argv: NC2_ARGV }]);
    const { l, out } = io(), c = run(fauxRaf(NC1), out);
    const raison = '2 revues non conformes du lot L1 (2026-11-13, 2026-11-14 en attente)';
    expect(relire(c)).toMatchObject({ modele: 'fable', modele_raison: raison, correction_revue: true, revue: NC2_ATTENTE });
    expect(l[0]).toContain(`session Fable (${raison}) en mode leger`);
    expect(appels.at(-1)!.args[appels.at(-1)!.args.indexOf('--model') + 1]).toBe('fable');
    expect(relire(c).passes?.[0]).toEqual({ quoi: 'correction 2 (après revue)', modele: 'fable', raison });
    // Ce que le run comptait avant L748 : la seule revue du plan, NC1 → opus.
    expect(revuesNonConformes([relire(b)], NC1)).toHaveLength(1);
  });

  it('sans le plan en attente, le même lot reste sur opus (une seule revue non conforme vue)', () => {
    const repo = depot('exit 0');
    minute(); executerRun({ repo, demande: 'x', lot: 'L1', raf: fauxRaf(), exec: fauxClaude([commite('a.txt')]), out: () => {} });
    minute(); const c = executerRun({ repo, demande: 'x', lot: 'L1', raf: fauxRaf(NC1), exec: fauxClaude([commite('b.txt')]), out: () => {} });
    expect(relire(c).modele).toBe('opus');
  });
});

describe('revueDuPlan lit le plan en attente (L748)', () => {
  it('la dernière revue du lot en attente est la revue courante, les autres et celle du plan sont précédentes', () => {
    const ici = dossierTemp('plan-');
    attente(ici, [
      { date: '2026-11-14T12:00:00.000Z', argv: NC2_ARGV },
      { date: '2026-11-15T12:00:00.000Z', argv: ['review', 'L1', 'non', 'conforme', ':', 'encore', '--verbose', '--vu', 'aucun'] },
    ]);
    const nc3: Revue = { date: '2026-11-15', verdict: 'non conforme : encore', commit: null, en_attente: true };
    expect(revueDuPlan(ici, 'L1', fauxRaf(NC1))).toEqual({ revue: nc3, precedentes: [NC1, NC2_ATTENTE] });
    expect(revuesNonConformes([], nc3, [NC1, NC2_ATTENTE])).toHaveLength(3);
  });

  it('ignore ux, review enable, les autres lots et les autres écritures', () => {
    const ici = dossierTemp('plan-');
    attente(ici, [
      { date: '2026-11-14T12:00:00.000Z', argv: ['ux', 'L1', 'non conforme : contraste'] },
      { date: '2026-11-14T12:00:00.000Z', argv: ['review', 'enable'] },
      { date: '2026-11-14T12:00:00.000Z', argv: ['review', 'L12', 'non conforme : x', '--vu', 'ccc'] },
      { date: '2026-11-14T12:00:00.000Z', argv: ['note', 'L1', 'review L1 non conforme'] },
    ]);
    expect(revuesEnAttente(ici, 'L1')).toEqual({ revues: [] });
    expect(revueDuPlan(ici, 'L1', fauxRaf(NC1))).toEqual({ revue: NC1 });
  });

  it('plan illisible : la revue en attente compte quand même ; plan en attente illisible : la revue du plan compte, l\'erreur est nommée', () => {
    const a = dossierTemp('plan-');
    attente(a, [{ date: '2026-11-14T12:00:00.000Z', argv: NC2_ARGV }]);
    expect(revueDuPlan(a, 'L1', fauxRaf(null))).toEqual({ revue: NC2_ATTENTE, erreur: 'plan illisible (raf list : plan introuvable)' });
    const b = dossierTemp('plan-');
    attente(b, 'a: [');
    const r = revueDuPlan(b, 'L1', fauxRaf(NC1));
    expect(r.revue).toEqual(NC1);
    expect(r.erreur).toMatch(/^plan en attente illisible \(\.cadence\/plan-en-attente\.yaml : [^\n]+\)$/);
  });

  it('une revue en attente puis appliquée le lendemain (même commit) reste une seule revue', () => {
    const appliquee: Revue = { date: '2026-11-15', verdict: 'non conforme : doc muette', commit: 'bbb' };
    expect(revuesNonConformes([{ id: 'c', repo: 'r', etat: 'integre', revue: NC2_ATTENTE }], appliquee)).toHaveLength(1);
    // sans commit connu, le jour départage toujours
    expect(revuesNonConformes([{ id: 'c', repo: 'r', etat: 'integre', revue: { ...NC1, commit: null } }], { ...NC1, date: '2026-11-14', commit: null })).toHaveLength(2);
  });
});
