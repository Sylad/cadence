import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RafError } from './plan.js';
import { isObject, readYamlKey } from './yaml-keys.js';

/**
 * L696 (D-11, erreur 2 du relevé du 10-11) : dix versions publiées cassées ou rouges, chaque correctif n'ayant bouché qu'un cas
 * (2.0.0 et 2.0.1 sans v2/briefs/bras-A.md : cadence run en mode léger plantait chez un utilisateur npm). Avant le tag,
 * cadence release essaie l'artefact réel : `npm pack` de HEAD (un worktree détaché : ce qui n'est pas commité n'y entre pas),
 * installation du tarball dans un dossier vide, puis des commandes de fumée lancées depuis ce paquet installé.
 */

const FUMEE_MS = 5 * 60_000;
const SORTIE_MAX = 4000;

/** Clé `release:` de cadence.yaml : `release.smoke`, les commandes de fumée (bash, une par entrée). */
export function readReleaseConfig(file: string): { smoke?: string[] } {
  const r = readYamlKey(file, 'release');
  if (r == null) return {};
  if (!isObject(r)) throw new RafError(`${file} : release doit être un objet { smoke }`);
  for (const k of Object.keys(r)) if (k !== 'smoke') throw new RafError(`${file} : release.${k} inconnu (attendu : smoke)`);
  if (r.smoke == null) return {};
  if (!Array.isArray(r.smoke) || r.smoke.some((c) => typeof c !== 'string' || !c.trim())) throw new RafError(`${file} : release.smoke doit être une liste de commandes non vides`);
  return { smoke: r.smoke.map((c: string) => c.trim()) };
}

/** Les commandes à jouer : `release.smoke`, sinon `<bin> --help` pour chaque bin de package.json. */
export function commandesFumee(root: string, pkg: Record<string, any>): string[] {
  const declarees = readReleaseConfig(join(root, 'cadence.yaml')).smoke;
  if (declarees) return declarees;
  const bin = pkg.bin;
  const noms = typeof bin === 'string' ? [String(pkg.name ?? '').replace(/^@[^/]+\//, '')] : isObject(bin) ? Object.keys(bin) : [];
  return noms.filter(Boolean).map((n) => `${n} --help`);
}

type Sortie = { status: number | null; stdout?: string; stderr?: string; error?: Error };
const texte = (r: Sortie) => `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
const queue = (s: string) => (s.length > SORTIE_MAX ? `…${s.slice(-SORTIE_MAX)}` : s);
const refus = (etape: string, r: Sortie) =>
  new RafError(`release : la fumée du paquet installé est rouge, rien n'est écrit — ${etape} (code ${r.status ?? r.error?.message ?? '?'})\n${queue(texte(r))}`);

/** L'environnement des commandes : ni variables CADENCE_* d'une session ou d'un run, ni GIT_* d'un hook (elles viseraient un autre dépôt). */
function environnement(bin: string, paquet: string, root: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CADENCE_') && !k.startsWith('GIT_')));
  return { ...env, PATH: `${bin}:${process.env.PATH ?? ''}`, CADENCE_FUMEE_PAQUET: paquet, CADENCE_FUMEE_RACINE: root };
}

/** Les node_modules non suivis du dépôt, liés dans le worktree : `prepare` (tsc) y trouve ses outils sans `npm ci`. */
function lierDependances(root: string, wt: string): void {
  const r = spawnSync('find', [root, '-maxdepth', '3', '-name', '.git', '-prune', '-o', '-name', 'node_modules', '-prune', '-print'], { encoding: 'utf8' });
  for (const d of (r.stdout ?? '').split('\n').filter(Boolean)) {
    const cible = join(wt, d.slice(root.length + 1));
    if (existsSync(cible) || !existsSync(join(cible, '..'))) continue;
    symlinkSync(d, cible, 'dir');
  }
}

/** Fait le paquet de HEAD, l'installe dans un dossier vide et joue `commandes` ; lève au premier rouge, avec la commande et sa sortie. */
export function fumerPaquet(root: string, commandes: string[], out: (l: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-fumee-'));
  const source = join(tmp, 'source');
  const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  try {
    const wt = git('worktree', 'add', '-q', '--detach', source, 'HEAD');
    if (wt.status !== 0) throw refus('git worktree add de HEAD', wt);
    lierDependances(root, source);
    const pack = spawnSync('npm', ['pack', '--pack-destination', tmp], { cwd: source, encoding: 'utf8', maxBuffer: 64 << 20, timeout: FUMEE_MS });
    if (pack.status !== 0) throw refus('$ npm pack', pack);
    const fichier = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!fichier) throw refus('$ npm pack (aucun .tgz produit)', pack);
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string };
    const installe = join(tmp, 'installe');
    mkdirSync(installe);
    writeFileSync(join(installe, 'package.json'), '{ "name": "fumee", "private": true }\n');
    const npmI = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', join(tmp, fichier)], { cwd: installe, encoding: 'utf8', maxBuffer: 64 << 20, timeout: FUMEE_MS });
    if (npmI.status !== 0) throw refus(`$ npm install ${fichier} (dans un dossier vide)`, npmI);
    out(`fumée du paquet : ${fichier} installé dans un dossier vide`);
    const env = environnement(join(installe, 'node_modules', '.bin'), join(installe, 'node_modules', pkg.name), root);
    commandes.forEach((c, i) => {
      const cwd = join(tmp, `essai-${i + 1}`);
      mkdirSync(cwd);
      const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: FUMEE_MS });
      if (r.status !== 0) throw refus(`$ ${c}`, r);
      out(`  ✓ ${c}`);
    });
  } finally {
    git('worktree', 'remove', '--force', source);
    rmSync(tmp, { recursive: true, force: true });
    git('worktree', 'prune');
  }
}
