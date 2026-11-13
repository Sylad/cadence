import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun, fichierVerrou, repondreRun, type Etat } from '../src/run/run.js';
import { heureLocale } from '../src/run/quota.js';
import { commite, depot, fauxClaude, git, horloge, io } from './run-outils.js';

// D-15 (L700) : la fin de quota d'une session claude -p, reconnue au texte de son résultat, met le run en état « quota » (pas « echec »).
const HEBDO = "You've hit your weekly limit · resets Thu 9am (Europe/Paris)";
const OPUS = "You've hit your Opus limit · resets Fri 10am (Europe/Paris)";
const REPRISE = '2026-11-12T08:00:00.000Z'; // jeudi 12-11 9 h à Paris, vu du mercredi 11-11 17 h
type Appels = { args: string[]; env: NodeJS.ProcessEnv }[];
const arg = (a: Appels, i: number, nom: string) => a[i].args[a[i].args.indexOf(nom) + 1];

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

  it('cadence run --liste : un run en quota dont un processus vivant attend montre l heure de reprise et ce processus', async () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([() => HEBDO]), out: () => {}, ...horloge(), attendre: null });
    writeFileSync(fichierVerrou(e.fichier), JSON.stringify({ pid: process.pid, role: 'attente', depuis: new Date().toISOString() }));
    await cmdRun(['--liste'], { cwd: repo, env: {}, out, err: out, now: () => new Date() });
    expect(l).toEqual([`${e.id}  quota  Crée fait.txt  · limite hebdo, reprise seule après ${heureLocale(REPRISE)} (processus ${process.pid} en attente)`]);
  });
});

// Revue L700 r1 (D-18) : un seul processus joue ou attend un run à la fois (verrou <run>.verrou), et une attente morte se voit.
describe('cadence run : verrou du run et attente morte (D-18)', () => {
  const MORT = { pid: process.pid, start: 'un autre processus', role: 'attente', depuis: '2026-11-11T16:00:00Z' }; // pid repris : porteur mort

  it('le verrou est tenu pendant la session, au nom de ce processus, et rendu à la fin du run', () => {
    const repo = depot(), vus: unknown[] = [];
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { vus.push(JSON.parse(readFileSync(fichierVerrou(`${cwd}.json`), 'utf8'))); commite('fait.txt')(cwd); }]), out: () => {}, ...horloge() });
    expect(e.etat).toBe('integre');
    expect(vus).toEqual([expect.objectContaining({ pid: process.pid, role: 'session' })]);
    expect(existsSync(fichierVerrou(e.fichier))).toBe(false);
  });

  it('un --reponse pendant que le run attend le quota est refusé avec le pid qui attend ; une seule reprise, celle de l attente', () => {
    const repo = depot(), appels: Appels = [], h = horloge(), refus: string[] = [], roles: string[] = [];
    let fichier = '';
    const exec = fauxClaude([(cwd) => { fichier = `${cwd}.json`; return HEBDO; }, commite('fait.txt')], appels);
    const attendre = (ms: number) => {
      h.attendre(ms);
      roles.push((JSON.parse(readFileSync(fichierVerrou(fichier), 'utf8')) as { role: string }).role);
      const id = (JSON.parse(readFileSync(fichier, 'utf8')) as Etat).id;
      try { repondreRun(id, repo, 'reprends', { exec, out: () => {} }); } catch (x) { refus.push((x as Error).message); }
    };
    const e = executerRun({ repo, demande: 'x', exec, out: () => {}, maintenant: h.maintenant, attendre });
    expect(e.etat).toBe('integre');
    expect(appels).toHaveLength(2); // la session de départ et la reprise de l'attente, jamais une troisième
    expect(refus.length).toBeGreaterThan(0);
    expect(refus[0]).toMatch(new RegExp(`processus ${process.pid} attend la remise à zéro du quota`));
    expect(refus[0]).toMatch(/kill \d+/);
    expect(roles.every((r) => r === 'attente')).toBe(true);
    expect(existsSync(fichierVerrou(e.fichier))).toBe(false);
  });

  it('un --reponse pendant qu une session du run tourne est refusé', () => {
    const repo = depot(), refus: string[] = [];
    const exec = fauxClaude([(cwd) => {
      const id = (JSON.parse(readFileSync(`${cwd}.json`, 'utf8')) as Etat).id;
      try { repondreRun(id, repo, 'autre chose', { exec: fauxClaude([]), out: () => {} }); } catch (x) { refus.push((x as Error).message); }
      commite('fait.txt')(cwd);
    }]);
    expect(executerRun({ repo, demande: 'x', exec, out: () => {}, ...horloge() }).etat).toBe('integre');
    expect(refus).toEqual([expect.stringMatching(new RegExp(`une session de ce run tourne déjà \\(processus ${process.pid}\\)`))]);
  });

  it('le scénario de la revue : attente morte, --reponse avant la remise à zéro, le quota revient à la même heure ; ce --reponse attend seul et reprend une fois', () => {
    const repo = depot(), appels: Appels = [], h = horloge();
    const exec = fauxClaude([() => HEBDO, () => HEBDO, commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {}, ...h, attendre: null });
    writeFileSync(fichierVerrou(e1.fichier), JSON.stringify(MORT)); // l'attente d'origine a été tuée : son verrou reste, mort
    const e2 = repondreRun(e1.id, repo, 'reprends', { exec, out: () => {}, ...h });
    expect(e2.etat).toBe('integre');
    expect(appels).toHaveLength(3);
    expect(arg(appels, 2, '-p')).toMatch(/quota est revenu/);
    expect(existsSync(fichierVerrou(e1.fichier))).toBe(false);
  });

  it('cadence run --liste : un run en quota sans processus vivant qui attend est dit arrêté, avec la commande de reprise', async () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([() => HEBDO]), out: () => {}, ...horloge(), attendre: null });
    const arrete = `${e.id}  quota  Crée fait.txt  · limite hebdo, attente arrêtée (aucun processus n'attend ; reprise prévue ${heureLocale(REPRISE)}) : reprendre : cadence run --reponse ${e.id} "reprends"`;
    await cmdRun(['--liste'], { cwd: repo, env: {}, out, err: out, now: () => new Date() });
    writeFileSync(fichierVerrou(e.fichier), JSON.stringify(MORT));
    await cmdRun(['--liste'], { cwd: repo, env: {}, out, err: out, now: () => new Date() });
    expect(l).toEqual([arrete, arrete]);
  });
});
