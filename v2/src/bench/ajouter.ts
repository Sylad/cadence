import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { Taille } from './banc.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function ajouterBanc(o: { racine: string; projetDir: string; lot: string; demande: string; install: string; tests: string; taille: Taille; visible: boolean }): string {
  const commits = git(o.projetDir, 'log', '--reverse', '--format=%H', '-E', `--grep=\\b${echapper(o.lot)}\\b`).split('\n').filter(Boolean);
  if (commits.length === 0) throw new Error(`lot ${o.lot} : aucun commit ne le cite dans ${o.projetDir}`);
  const base = git(o.projetDir, 'rev-parse', `${commits[0]}^`);
  const dirBancs = join(o.racine, 'bancs');
  const n = 1 + Math.max(0, ...(existsSync(dirBancs) ? readdirSync(dirBancs) : []).map((id) => Number(id.split('-')[0]) || 0));
  const id = `${n}-${basename(o.projetDir)}-${o.lot}`;
  const dir = join(dirBancs, id); const secrets = join(o.racine, 'secrets', id);
  mkdirSync(dir, { recursive: true }); mkdirSync(join(secrets, 'tests-origine'), { recursive: true });
  writeFileSync(join(dir, 'banc.yaml'), stringify({ projet: basename(o.projetDir), source: o.projetDir, base, install: o.install, tests: o.tests,
    visible: o.visible, taille: o.taille, frais: true }));
  writeFileSync(join(dir, 'demande.md'), `${o.demande.trim()}\n`);
  const dernier = commits.at(-1)!;
  writeFileSync(join(secrets, 'diff-origine.patch'), commits.map((c) => git(o.projetDir, 'show', '--format=### %h %s', c)).join('\n'));
  const fichiers = new Set(commits.flatMap((c) => git(o.projetDir, 'show', '--name-only', '--format=', c).split('\n'))
    .filter((f) => /(test|spec)/.test(f) && !f.startsWith('docs/')));
  for (const f of fichiers) {
    try {
      const contenu = git(o.projetDir, 'show', `${dernier}:${f}`);
      mkdirSync(dirname(join(secrets, 'tests-origine', f)), { recursive: true });
      writeFileSync(join(secrets, 'tests-origine', f), contenu);
    } catch { /* fichier supprimé par le lot */ }
  }
  writeFileSync(join(secrets, 'mesure.md'), `# Mesure — banc frais ${id}\n\n## Conformité\nJugée contre demande.md et le diff d'origine (${join(secrets, 'diff-origine.patch')}) : le comportement livré à l'origine est l'attendu.\nTests cachés : ${join(secrets, 'tests-origine')} (fichiers de test touchés par le lot), commande de suite : \`${o.tests}\`.\n`);
  writeFileSync(join(secrets, 'attendu.md'), `Le comportement du diff d'origine : ${join(secrets, 'diff-origine.patch')}.\n`);
  chmodSync(secrets, 0o700);
  return id;
}
