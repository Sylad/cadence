import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { heureLocale } from '../src/run/quota.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

// D-15 (L700) : la fin de quota d'une session claude -p, reconnue au texte de son résultat, met le run en état « quota » (pas « echec »).
const HEBDO = "You've hit your weekly limit · resets Thu 9am (Europe/Paris)";
const OPUS = "You've hit your Opus limit · resets Fri 10am (Europe/Paris)";
const REPRISE = '2026-11-12T08:00:00.000Z'; // jeudi 12-11 9 h à Paris, vu du mercredi 11-11 17 h
type Appels = { args: string[]; env: NodeJS.ProcessEnv }[];
const arg = (a: Appels, i: number, nom: string) => a[i].args[a[i].args.indexOf(nom) + 1];
/** Une horloge simulée que l'attente fait avancer : aucun test ne dort vraiment. */
function horloge(debut = '2026-11-11T16:00:00Z') {
  let t = Date.parse(debut);
  const attentes: number[] = [];
  return { attentes, maintenant: () => new Date(t), attendre: (ms: number) => { attentes.push(ms); t += ms; } };
}

describe('cadence run : fin de quota (D-15)', () => {
  it('limite hebdo : état quota avec l heure de reprise, branche rendue, worktree gardé ; sans attente, rien d autre', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io(), h = horloge();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([() => HEBDO], appels), out, maintenant: h.maintenant, attendre: null });
    expect(e).toMatchObject({ etat: 'quota', quota: { limite: 'hebdo', reprise: REPRISE }, session: 's1', modele: 'opus' });
    expect(JSON.parse(readFileSync(e.fichier, 'utf8'))).toMatchObject({ etat: 'quota', quota: { limite: 'hebdo', reprise: REPRISE } });
    expect(appels).toHaveLength(1);
    expect(existsSync(e.worktree)).toBe(true);
    const fin = l.join('\n');
    expect(fin).toMatch(new RegExp(`cadence run ${e.id} : quota`));
    expect(fin).toMatch(new RegExp(`limite hebdo atteinte ; reprise seule après ${heureLocale(REPRISE)}`));
    expect(fin).toMatch(new RegExp(`cadence run --reponse ${e.id}`));
    expect(fin).not.toMatch(/echec/);
  });

  it('limite hebdo : le run attend l heure de remise à zéro puis reprend LA MÊME session dans le même worktree, avec le même modèle, et intègre', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io(), h = horloge();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([() => HEBDO, commite('fait.txt')], appels), out, ...h });
    expect(e.etat).toBe('integre');
    expect(appels).toHaveLength(2);
    expect(arg(appels, 1, '--resume')).toBe('s1');
    expect(arg(appels, 1, '--model')).toBe('opus');
    expect(arg(appels, 1, '-p')).toMatch(/quota est revenu/);
    expect(h.maintenant().getTime()).toBeGreaterThanOrEqual(Date.parse(REPRISE));
    expect(h.maintenant().getTime() - Date.parse(REPRISE)).toBeLessThan(10 * 60_000);
    expect(l.join('\n')).toMatch(/quota revenu : reprise de la session s1/);
    expect(git(repo, 'log', '--oneline', '-1')).toMatch(/ajoute fait.txt/);
  });

  it('limite hebdo sur un run en fable : jamais de bascule de modèle (la limite hebdo bloque tous les modèles)', () => {
    const repo = depot(), appels: Appels = [], h = horloge();
    const e = executerRun({ repo, demande: 'x', modele: 'fable', exec: fauxClaude([() => HEBDO, commite('fait.txt')], appels), out: () => {}, ...h });
    expect(e.etat).toBe('integre');
    expect(appels.map((_, i) => arg(appels, i, '--model'))).toEqual(['fable', 'fable']);
  });

  it('limite Opus : bascule sur fable en reprenant la même session, sans attendre ; l état garde fable', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io(), h = horloge();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([() => OPUS, commite('fait.txt')], appels), out, ...h });
    expect(e).toMatchObject({ etat: 'integre', modele: 'fable' });
    expect(h.attentes).toEqual([]);
    expect(arg(appels, 0, '--model')).toBe('opus');
    expect(arg(appels, 1, '--model')).toBe('fable');
    expect(arg(appels, 1, '--resume')).toBe('s1');
    expect(l.join('\n')).toMatch(/limite Opus atteinte : bascule sur fable/);
  });

  it('limite Opus sur un run déjà en fable : état quota, pas de boucle', () => {
    const repo = depot(), appels: Appels = [], h = horloge();
    const e = executerRun({ repo, demande: 'x', modele: 'fable', exec: fauxClaude([() => OPUS], appels), out: () => {}, ...h, attendre: null });
    expect(e).toMatchObject({ etat: 'quota', quota: { limite: 'opus' } });
    expect(appels).toHaveLength(1);
  });

  it('quota pendant la correction de la porte : la reprise rejoue la porte puis intègre', () => {
    const repo = depot(), appels: Appels = [], h = horloge();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('autre.txt'), () => HEBDO, commite('fait.txt')], appels), out: () => {}, ...h });
    expect(e.etat).toBe('integre');
    expect(arg(appels, 2, '--resume')).toBe('s2'); // l'id rendu par le dernier passage (le faux claude en donne un par appel)
    expect(arg(appels, 2, '-p')).toMatch(/quota est revenu/);
  });

  it('heure de reprise illisible : état quota, aucune reprise seule, --reponse le dit', () => {
    const repo = depot(), appels: Appels = [], { l, out } = io(), h = horloge();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([() => "You've hit your weekly limit · resets soon"], appels), out, ...h });
    expect(e).toMatchObject({ etat: 'quota', quota: { reprise: null } });
    expect(h.attentes).toEqual([]);
    expect(l.join('\n')).toMatch(/heure de reprise illisible/);
  });

  it('à la demande : cadence run --reponse reprend un run en quota dans la même session', () => {
    const repo = depot(), appels: Appels = [];
    const exec = fauxClaude([() => HEBDO, commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {}, ...horloge(), attendre: null });
    const e2 = repondreRun(e1.id, repo, 'reprends', { exec, out: () => {} });
    expect(e2.etat).toBe('integre');
    expect(arg(appels, 1, '--resume')).toBe('s1');
    expect(e2.quota).toBeUndefined();
  });

  it('une reprise faite ailleurs (--reponse) pendant l attente : le run qui attendait s arrête sans relancer la session', () => {
    const repo = depot(), appels: Appels = [], h = horloge();
    let fichier = '';
    const attendre = (ms: number) => {
      h.attendre(ms);
      const e = JSON.parse(readFileSync(fichier, 'utf8')) as Etat;
      writeFileSync(fichier, JSON.stringify({ ...e, etat: 'en-cours', quota: undefined }));
    };
    const exec = fauxClaude([(cwd) => { fichier = `${cwd}.json`; return HEBDO; }], appels);
    const e = executerRun({ repo, demande: 'x', exec, out: () => {}, maintenant: h.maintenant, attendre });
    expect(appels).toHaveLength(1);
    expect(e.etat).toBe('en-cours');
  });

  it('cadence run --liste affiche l état quota, la limite et l heure de reprise', async () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([() => HEBDO]), out: () => {}, ...horloge(), attendre: null });
    await cmdRun(['--liste'], { cwd: repo, env: {}, out, err: out, now: () => new Date() });
    expect(l).toEqual([`${e.id}  quota  Crée fait.txt  · limite hebdo, reprise après ${heureLocale(REPRISE)}`]);
  });
});
