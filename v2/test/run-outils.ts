// Outils des tests de cadence run : un dépôt jetable, un faux claude, un commit dans le worktree.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Executeur } from '../src/bench/bras.js';
import type { Etat } from '../src/run/run.js';
import { dossierTemp } from './temp.js';

export const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
export function depot(porte = 'test -f fait.txt'): string {
  const r = dossierTemp('run-'), repo = join(r, 'projet');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'x');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: ${porte}\n`);
  git(r, 'init', '-q', '-b', 'main', repo); git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return repo;
}
export const sortie = (session: string, result = 'fini') => JSON.stringify({ session_id: session, total_cost_usd: 0.1, result, subtype: 'success' });
/** Faux claude : chaque appel joue une action dans le worktree (cwd) puis rend une sortie JSON ; une action qui rend un texte simule une fin de quota
 * (D-15) : ce texte est le résultat, avec is_error et le code 1, comme claude -p quand la limite est atteinte. */
export const fauxClaude = (actions: ((cwd: string, args: string[], env: NodeJS.ProcessEnv) => void | string)[], appels: { args: string[]; env: NodeJS.ProcessEnv }[] = []): Executeur =>
  (args, o) => {
    appels.push({ args, env: o.env });
    const quota = (actions.shift() ?? (() => {}))(o.cwd, args, o.env);
    if (typeof quota === 'string') return { stdout: JSON.stringify({ session_id: `s${appels.length}`, total_cost_usd: 0, result: quota, is_error: true, subtype: 'success' }), code: 1 };
    return { stdout: sortie(`s${appels.length}`), code: 0 };
  };
export const commite = (fichier: string, demande?: string) => (cwd: string) => {
  writeFileSync(join(cwd, fichier), 'ok');
  if (demande) { mkdirSync(join(cwd, '.cadence', 'demandes'), { recursive: true }); writeFileSync(join(cwd, '.cadence', 'demandes', 'D-1.json'), JSON.stringify({ id: 'D-1', texte: demande, etat: 'ouverte' })); }
  git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `ajoute ${fichier}`);
};
/** Une horloge simulée que l'attente du quota (D-15) fait avancer : aucun test ne dort vraiment. */
export function horloge(debut = '2026-11-11T16:00:00Z') {
  let t = Date.parse(debut);
  const attentes: number[] = [];
  return { attentes, maintenant: () => new Date(t), attendre: (ms: number) => { attentes.push(ms); t += ms; } };
}
export const io = () => { const l: string[] = []; return { l, out: (x: string) => l.push(x) }; };

// Outils des tests qui lancent cadence run dans de vrais processus (L709, L711).
export const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function attendre<T>(quoi: () => T | undefined, ms: number, sinon: string): Promise<T> {
  for (const fin = Date.now() + ms; Date.now() < fin; await new Promise((r) => setTimeout(r, 100))) { const v = quoi(); if (v !== undefined) return v; }
  throw new Error(sinon);
}
export const etats = (repo: string) => { const d = join(dirname(repo), '.cadence-run'); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Etat) : []; };

/** Faux claude : note son pid, ses arguments et son environnement, attend le signal du test, puis commite fait.txt et rend l'id de --session-id. */
export function fauxClaudeBin(trace: string): string {
  const bin = join(dossierTemp('fond-bin-'), 'claude');
  writeFileSync(bin, `#!/bin/bash
sid=; prec=; for a in "$@"; do [ "$prec" = --session-id ] && sid=$a; prec=$a; done
printf '%s\\n' "$@" > "${trace}/args"; env > "${trace}/env"; echo $$ > "${trace}/claude.pid"
for i in $(seq 300); do [ -f "${trace}/go" ] && break; sleep 0.1; done
echo ok > fait.txt; git add -A; git -c user.email=t@t -c user.name=t commit -qm 'ajoute fait.txt'
printf '{"session_id":"%s","total_cost_usd":0,"result":"fini","subtype":"success"}' "$sid"
`);
  chmodSync(bin, 0o755);
  return dirname(bin);
}
