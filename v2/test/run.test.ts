import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { dossierTemp } from './temp.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function depot(porte = 'test -f fait.txt'): string {
  const r = dossierTemp('run-'), repo = join(r, 'projet');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'x');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: ${porte}\n`);
  git(r, 'init', '-q', '-b', 'main', repo); git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return repo;
}
const sortie = (session: string, result = 'fini') => JSON.stringify({ session_id: session, total_cost_usd: 0.1, result, subtype: 'success' });
/** Faux claude : chaque appel joue une action dans le worktree (cwd) puis rend une sortie JSON. */
const fauxClaude = (actions: ((cwd: string, args: string[], env: NodeJS.ProcessEnv) => void)[], appels: { args: string[]; env: NodeJS.ProcessEnv }[] = []): Executeur =>
  (args, o) => { appels.push({ args, env: o.env }); (actions.shift() ?? (() => {}))(o.cwd, args, o.env); return { stdout: sortie(`s${appels.length}`), code: 0 }; };
const commite = (fichier: string, demande?: string) => (cwd: string) => {
  writeFileSync(join(cwd, fichier), 'ok');
  if (demande) { mkdirSync(join(cwd, '.cadence', 'demandes'), { recursive: true }); writeFileSync(join(cwd, '.cadence', 'demandes', 'D-1.json'), JSON.stringify({ id: 'D-1', texte: demande, etat: 'ouverte' })); }
  git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `ajoute ${fichier}`);
};
const io = () => { const l: string[] = []; return { l, out: (x: string) => l.push(x) }; };

describe('cadence run', () => {
  it('une demande : worktree avec dépendances, session avec brief mesuré et hook, porte verte, intégration en avance rapide, worktree retiré', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let vu = { deps: false };
    const exec = fauxClaude([(cwd, a, e) => { vu.deps = existsSync(join(cwd, 'node_modules', 'dep', 'index.js')); commite('fait.txt', 'pour plus tard : un export')(cwd); void a; void e; }], appels);
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', pieces: ['cadence.yaml'], exec, out });
    expect(e.etat).toBe('integre');
    expect(vu.deps).toBe(true);
    expect(git(repo, 'log', '--oneline', '-1')).toMatch(/ajoute fait.txt/);
    expect(existsSync(e.worktree)).toBe(false);
    expect(existsSync(`${e.worktree}.reglages`)).toBe(false);
    const [args, env] = [appels[0].args, appels[0].env];
    expect(args[args.indexOf('-p') + 1]).toMatch(/^Crée fait.txt[\s\S]*Registre des demandes/);
    expect(args).toContain('--settings');
    expect(env.CADENCE_CLONE).toBe(e.worktree);
    expect(JSON.parse(env.CADENCE_PIECES ?? '[]')).toEqual([join(e.worktree, 'cadence.yaml')]);
    expect(l.join('\n')).toMatch(/D-1 ouverte : pour plus tard : un export/);
  });

  it('porte rouge : la même session est reprise une fois avec la sortie de la porte, puis intégration', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec = fauxClaude([commite('autre.txt'), commite('fait.txt')], appels);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(appels[1].args).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(appels[1].args[appels[1].args.indexOf('-p') + 1]).toMatch(/porte complète est rouge/);
  });

  it('porte encore rouge après la reprise : rien n intégré, worktree gardé', () => {
    const repo = depot(), base = git(repo, 'rev-parse', 'HEAD');
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('a.txt'), commite('b.txt')]), out: () => {} });
    expect(e.etat).toBe('porte-rouge');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(existsSync(e.worktree)).toBe(true);
  });

  it('question : état « attente », puis --reponse reprend la session et termine', () => {
    const repo = depot();
    const exec = fauxClaude([(cwd) => writeFileSync(`${cwd}.question.md`, 'Rouge ou bleu ?'), commite('fait.txt')]);
    const { l, out } = io();
    const e1 = executerRun({ repo, demande: 'x', exec, out });
    expect(e1.etat).toBe('attente');
    expect(l.join('\n')).toMatch(/Rouge ou bleu \?/);
    const e2 = repondreRun(e1.id, repo, 'bleu', { exec, out });
    expect(e2.etat).toBe('integre');
  });

  it('la branche principale a avancé pendant la session : rebase puis intégration', () => {
    const repo = depot();
    const exec = fauxClaude([(cwd) => { commite('fait.txt')(cwd); commite('ailleurs.txt')(repo); }]);
    const e: Etat = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s')).toMatch(/ajoute fait.txt\najoute ailleurs.txt/);
  });

  it('aucun commit : échec, rien intégré', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([]), out: () => {} });
    expect(e.etat).toBe('sans-commit');
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).etat).toBe('sans-commit');
  });
});
