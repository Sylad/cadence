// L726 : aiguillage de modèle de cadence run. Opus par défaut ; Fable d'office à la 3e passe de correction du lot ou après deux revues non conformes ;
// la ligne de lancement et la fin du run disent quel modèle a joué chaque passe, et pourquoi.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { modeleDeDepart, nonConforme, revueApresIntegre, revueDuPlan, revuesNonConformes, type Revue, type RunDuLot } from '../src/run/escalade.js';
import { commite, depot, fauxClaude, horloge, io } from './run-outils.js';
import { dossierTemp } from './temp.js';

type Appels = { args: string[]; env: NodeJS.ProcessEnv }[];
const modeles = (a: Appels) => a.map((x) => x.args[x.args.indexOf('--model') + 1]);
const relire = (e: Etat) => JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
/** Faux raf : `raf list --json` rend le lot L1 avec la revue donnée ; `null` : raf échoue ; une chaîne : ce que raf écrit sur sa sortie. */
function fauxRaf(revue?: Revue | null | string): string {
  const f = join(dossierTemp('raf-'), 'raf.mjs');
  const liste = typeof revue === 'string' ? revue : JSON.stringify([{ id: 'L1', status: 'doing', ...(revue ? { review: revue } : {}) }]);
  writeFileSync(f, revue === null ? 'console.error("plan introuvable"); process.exit(1);\n'
    : `if (process.argv[2] === 'list') console.log(${JSON.stringify(liste)});\n`);
  return f;
}
const NC1: Revue = { date: '2026-11-13', verdict: 'non conforme : test manquant', commit: 'aaa' };
const NC2: Revue = { date: '2026-11-14', verdict: 'non conforme : doc muette', commit: 'bbb' };
const OK: Revue = { date: '2026-11-14', verdict: 'conforme (1 mineur)', commit: 'ccc' };
/** NC1 réécrite par raf review le même jour sur le même commit, verdict précisé. */
const NC1_REECRITE: Revue = { ...NC1, verdict: 'non conforme : test manquant (run.ts:142)' };
const OPUS = "You've hit your Opus limit · resets Fri 10am (Europe/Paris)";

describe('cadence run : modèle de chaque passe (L726)', () => {
  // L'id d'un run se date à la seconde : deux runs du même processus dans la même seconde auraient le même id. Chaque run de ces tests part une minute après.
  let t = Date.parse('2026-11-14T08:00:00Z');
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const minute = () => vi.setSystemTime((t += 60_000));
  it('sans lot ni choix : opus par défaut, dit au lancement et à la fin', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')], appels), out });
    expect(relire(e)).toMatchObject({ etat: 'integre', modele: 'opus', modele_raison: 'par défaut', passes: [{ quoi: 'travail', modele: 'opus', raison: 'par défaut' }] });
    expect(l[0]).toContain('session Opus (par défaut) en mode leger');
    expect(l).toContain('modèles : travail : Opus (par défaut) → id non lu');
  });

  it('3e correction de porte rouge dans un même run : bascule sur fable, même session, et la fin le dit passe par passe', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io();
    const exec = fauxClaude([commite('a.txt'), commite('b.txt'), commite('c.txt'), commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e1.etat).toBe('porte-rouge'); // correction 1 rouge
    const e3 = repondreRun(e1.id, repo, 'corrige', { exec, out }); // correction 2 (la réponse) rouge, puis correction 3 par le run lui-même
    expect(e3.etat).toBe('integre');
    expect(modeles(appels)).toEqual(['opus', 'opus', 'opus', 'fable']);
    expect(appels[3].args).toEqual(expect.arrayContaining(['--resume', 's3'])); // la même session
    expect(l).toContain('3e passe de correction : bascule sur fable, même session');
    expect(relire(e3).passes).toEqual([
      { quoi: 'travail', modele: 'opus', raison: 'par défaut' },
      { quoi: 'correction 1 (porte rouge)', modele: 'opus', raison: 'par défaut' },
      { quoi: 'correction 2 (porte rouge)', modele: 'opus', raison: 'par défaut' },
      { quoi: 'correction 3 (porte rouge)', modele: 'fable', raison: '3e passe de correction' },
    ]);
    expect(l).toContain('modèles : travail : Opus (par défaut) → id non lu · correction 1 (porte rouge) : Opus (par défaut) → id non lu · correction 2 (porte rouge) : Opus (par défaut) → id non lu'
      + ' · correction 3 (porte rouge) : Fable (3e passe de correction) → id non lu');
  });

  it('deux revues non conformes du lot : le run suivant part en fable dès le lancement, avec les dates des revues', () => {
    const repo = depot(), appels: Appels = [];
    const run = (raf: string, out = (_: string) => {}) => { minute(); return executerRun({ repo, demande: 'x', lot: 'L1', raf, exec: fauxClaude([commite(`f${appels.length}.txt`), commite('fait.txt')], appels), out }); };
    const a = run(fauxRaf()); // travail : porte rouge corrigée (correction 1), intégré
    expect(a.etat).toBe('integre');
    const b = run(fauxRaf(NC1)); // relancé après la revue NC1 : correction 2 (après revue), opus
    expect(relire(b)).toMatchObject({ etat: 'integre', modele: 'opus', correction_revue: true, corrections_avant: 1, revue: NC1 });
    const { l, out } = io(), c = run(fauxRaf(NC2), out);
    expect(relire(c)).toMatchObject({ modele: 'fable', modele_raison: '2 revues non conformes du lot L1 (2026-11-13, 2026-11-14)', revue: NC2 });
    expect(l[0]).toContain('session Fable (2 revues non conformes du lot L1 (2026-11-13, 2026-11-14)) en mode leger');
    expect(modeles(appels).slice(-1)).toEqual(['fable']);
    expect(relire(c).passes?.[0]).toEqual({ quoi: 'correction 3 (après revue)', modele: 'fable', raison: '2 revues non conformes du lot L1 (2026-11-13, 2026-11-14)' });
  });

  it('3e passe de correction du lot sur plusieurs runs : fable au lancement du run qui corrige après une revue non conforme neuve', () => {
    const repo = depot(), appels: Appels = [];
    const exec = fauxClaude([commite('a.txt'), commite('b.txt'), commite('fait.txt')], appels);
    minute(); const a = executerRun({ repo, demande: 'x', lot: 'L1', raf: fauxRaf(), exec, out: () => {} }); // correction 1 rouge
    expect(repondreRun(a.id, repo, 'corrige', { exec, out: () => {} }).etat).toBe('integre'); // correction 2 verte
    const { l, out } = io();
    minute(); const b = executerRun({ repo, demande: 'x', lot: 'L1', raf: fauxRaf(NC1), exec: fauxClaude([commite('c.txt')], appels), out });
    expect(l[0]).toContain('session Fable (3e passe de correction du lot L1)');
    expect(relire(b)).toMatchObject({ etat: 'integre', modele: 'fable', correction_revue: true, corrections_avant: 2 });
    expect(relire(b).passes).toEqual([{ quoi: 'correction 3 (après revue)', modele: 'fable', raison: '3e passe de correction du lot L1' }]);
  });

  it('lot livré en plusieurs runs sans revue non conforme neuve : ni correction après revue, ni fable', () => {
    const repo = depot(), appels: Appels = [], lances: Etat[] = [];
    // run 0 : travail + correction 1 (porte rouge), lancé sur NC1 ; runs 1 à 3 : sans revue, revue conforme, puis NC1 réécrite (déjà vue par le run 0)
    const rafs = [fauxRaf(NC1), fauxRaf(), fauxRaf(OK), fauxRaf(NC1_REECRITE)];
    rafs.forEach((raf, i) => {
      minute(); lances.push(executerRun({ repo, demande: 'x', lot: 'L1', raf, exec: fauxClaude([commite(`f${i}.txt`), ...(i ? [] : [commite('fait.txt')])], appels), out: () => {} }));
    });
    expect(lances.map((e) => [e.etat, e.modele])).toEqual([['integre', 'opus'], ['integre', 'opus'], ['integre', 'opus'], ['integre', 'opus']]);
    // le run 0 voit NC1 avant tout run intégré du lot : pas une correction ; le run 3 la revoit, réécrite : déjà traitée
    expect(lances.map((e) => relire(e).correction_revue)).toEqual([undefined, undefined, undefined, undefined]);
    expect(lances.slice(1).map((e) => relire(e).passes)).toEqual([1, 2, 3].map(() => [{ quoi: 'travail', modele: 'opus', raison: 'par défaut' }]));
  });

  it('limite Opus : la reprise sur fable est une passe, avec sa raison, dans passes et dans la ligne « modèles : » de fin', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io();
    minute(); const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([() => OPUS, commite('fait.txt')], appels), out, ...horloge() });
    expect(relire(e)).toMatchObject({ etat: 'integre', modele: 'fable', modele_raison: 'limite Opus atteinte' });
    expect(relire(e).passes).toEqual([{ quoi: 'travail', modele: 'opus', raison: 'par défaut' }, { quoi: 'reprise', modele: 'fable', raison: 'limite Opus atteinte' }]);
    expect(l).toContain('modèles : travail : Opus (par défaut) → id non lu · reprise : Fable (limite Opus atteinte) → id non lu');
  });

  it('lot absent du plan : opus, et la ligne de lancement dit que les revues ne sont pas comptées', () => {
    const repo = depot(), { l, out } = io();
    minute(); const e = executerRun({ repo, demande: 'x', lot: 'L2', raf: fauxRaf(NC1), exec: fauxClaude([commite('fait.txt')]), out });
    expect(relire(e)).toMatchObject({ etat: 'integre', modele: 'opus', modele_raison: 'par défaut ; revues non comptées : lot L2 absent du plan' });
    expect(l[0]).toContain('session Opus (par défaut ; revues non comptées : lot L2 absent du plan) en mode leger');
  });

  it('un run d\'un autre lot ou d\'un run non intégré ne compte pas ; plan illisible : opus, et la ligne dit que les revues ne sont pas comptées', () => {
    const repo = depot(), appels: Appels = [];
    minute(); executerRun({ repo, demande: 'x', lot: 'L9', raf: fauxRaf(), exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    minute(); expect(executerRun({ repo, demande: 'x', lot: 'L1', raf: fauxRaf(), exec: fauxClaude([], appels), out: () => {} }).etat).toBe('sans-commit');
    minute(); const { l, out } = io(), e = executerRun({ repo, demande: 'x', lot: 'L1', raf: fauxRaf(null), exec: fauxClaude([commite('g.txt')], appels), out });
    expect(relire(e)).toMatchObject({ etat: 'integre', modele: 'opus' });
    expect(relire(e).correction_revue).toBeUndefined();
    expect(l[0]).toMatch(/session Opus \(par défaut ; revues non comptées : plan illisible \(raf list : plan introuvable\)\) en mode leger/);
  });

  it('--modele fable reste fable, avec sa raison, même quand l\'escalade l\'aurait choisi', () => {
    const d = modeleDeDepart({ modele: 'fable', raison: '--modele' }, 'L1', [{ id: 'a', repo: 'r', lot: 'L1', etat: 'integre', revue: NC1 }], { revue: NC2 });
    expect([d.modele, d.raison]).toEqual(['fable', '--modele']);
  });
});

describe('revues non conformes (L726)', () => {
  it('même règle que isNonConformingVerdict : le verdict commence par « non conforme »', () => {
    expect(['non conforme : x', '« Non-conforme »', 'not compliant', 'NON CONFORME'].every(nonConforme)).toBe(true);
    expect(['conforme après 1 correction, non conforme avant', 'conforme', ''].some(nonConforme)).toBe(false);
  });
  it('revueDuPlan : la revue du lot, rien sans revue, et une erreur nommée pour un lot absent ou une sortie de raf illisible', () => {
    const ici = dossierTemp('plan-');
    expect(revueDuPlan(ici, 'L1', fauxRaf(NC1))).toEqual({ revue: NC1 });
    expect(revueDuPlan(ici, 'L1', fauxRaf())).toEqual({});
    expect(revueDuPlan(ici, 'L2', fauxRaf(NC1))).toEqual({ erreur: 'lot L2 absent du plan' });
    expect(revueDuPlan(ici, 'L1', fauxRaf('pas du json')).erreur).toMatch(/^plan illisible \(raf list : [^\n]*is not valid JSON\)$/);
    expect(revueDuPlan(ici, 'L1', fauxRaf(null))).toEqual({ erreur: 'plan illisible (raf list : plan introuvable)' });
  });
  it('une revue réécrite par raf review (même jour, même commit, verdict précisé) compte une fois', () => {
    const runs = [{ id: 'a', repo: 'r', etat: 'integre', revue: NC1 }];
    expect(revuesNonConformes(runs, NC1_REECRITE)).toHaveLength(1);
    expect(modeleDeDepart({ modele: 'opus', raison: 'par défaut' }, 'L1', runs, { revue: NC1_REECRITE }).modele).toBe('opus');
  });
  it('correction après revue : seulement une revue non conforme qu\'aucun run lancé jusqu\'au dernier run intégré n\'a vue', () => {
    const r = (id: string, debut: string, etat: string, revue?: Revue): RunDuLot => ({ id, repo: 'r', lot: 'L1', debut, etat, ...(revue ? { revue } : {}) });
    expect(revueApresIntegre([], NC1)).toBe(false); // aucun run intégré
    expect(revueApresIntegre([r('a', '1', 'integre')], undefined)).toBe(false); // aucune revue non conforme
    expect(revueApresIntegre([r('a', '1', 'integre')], NC1)).toBe(true);
    expect(revueApresIntegre([r('a', '1', 'integre', NC1)], NC1_REECRITE)).toBe(false); // déjà vue par le run intégré
    expect(revueApresIntegre([r('a', '1', 'echec', NC1), r('b', '2', 'integre')], NC1)).toBe(false); // vue avant le run intégré
    expect(revueApresIntegre([r('a', '1', 'integre'), r('b', '2', 'echec', NC1)], NC1)).toBe(true); // vue par une tentative ratée après lui : toujours à corriger
  });
  it('une même revue vue par deux runs compte une fois ; une revue conforme ne compte pas', () => {
    const runs = [{ id: 'a', repo: 'r', etat: 'integre', revue: NC1 }, { id: 'b', repo: 'r', etat: 'integre', revue: NC1 }, { id: 'c', repo: 'r', etat: 'integre', revue: OK }];
    expect(revuesNonConformes(runs, NC1)).toEqual([NC1]);
    expect(revuesNonConformes(runs, NC2)).toEqual([NC1, NC2]);
  });
});
