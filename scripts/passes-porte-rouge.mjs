// Mesure de L842 (D-33) : la part des passes « porte rouge » de `cadence run` qui finissent sans commit de code, avant et après le rejeu seul des rouges.
// L'étude du 25-11 (docs/etudes/2026-11-25-temps-lot-prod-et-tests.md) comptait 22 corrections de porte sur 54 venues de tests sensibles à la charge.
// Lit les états des runs (`.cadence-run/*.json`, à côté des dépôts) : chaque correction après porte rouge porte, depuis L842, les commits et les fichiers de ses
// sessions ; une correction d'avant n'a pas ces champs et compte « non mesurée ». Les tests sensibles à la charge (verts rejoués seuls, sans passe) sont comptés à part.
//   node scripts/passes-porte-rouge.mjs [--runs <dossier .cadence-run>] [--depuis <date ISO>] [--json]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Un fichier qui n'est pas du code : le plan et le registre, la doc, les fragments de changelog, le Markdown. */
const HORS_CODE = /^(?:\.cadence\/|docs\/|changelog\.d\/)|\.md$|(?:^|\/)CHANGELOG[^/]*$/;
export const fichierDeCode = (f) => !HORS_CODE.test(f);

/** Les états de run du dossier (fichiers `*.json` lisibles qui ont un `id` et un `repo`), depuis `depuis` (date ISO de `debut`) quand elle est donnée. */
export function lireEtats(dossier, depuis) {
  if (!existsSync(dossier)) return [];
  const etats = [];
  for (const f of readdirSync(dossier).filter((x) => x.endsWith('.json')).sort()) {
    let e;
    try { e = JSON.parse(readFileSync(join(dossier, f), 'utf8')); } catch { continue; }
    if (e?.id && e.repo && (!depuis || (e.debut ?? '') >= depuis)) etats.push(e);
  }
  return etats;
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Ajoute à la correction `c` ce que le worktree `cwd` a commité depuis `avant` (cumulé sur ses sessions : reprise après quota, --reponse). */
function cumuler(c, cwd, avant) {
  c.commits = (c.commits ?? 0) + Number(git(cwd, 'rev-list', '--count', `${avant}..HEAD`));
  const fichiers = git(cwd, 'log', '--format=', '--name-only', `${avant}..HEAD`).split('\n').filter(Boolean);
  c.fichiers = [...new Set([...(c.fichiers ?? []), ...fichiers])].sort();
}

/** Côté `cadence run` : joue `f` (une session) ; `actif` (une correction après porte rouge), ses commits et leurs fichiers s'ajoutent à la dernière correction. */
export function avecMesure(corrections, cwd, actif, f) {
  const c = actif ? corrections?.at(-1) : undefined;
  const avant = c ? git(cwd, 'rev-parse', 'HEAD') : '';
  const r = f();
  if (c) cumuler(c, cwd, avant);
  return r;
}

const vide = () => ({ runs: 0, passes: 0, mesurees: 0, sansCode: 0, sansCommit: 0, nonMesurees: 0, sensibles: 0, runsSensibles: 0 });

/** Ajoute une correction jugée par la porte aux comptes `m` (une correction encore en cours, sans `verte`, n'est pas comptée). */
function compterCorrection(m, c) {
  if (c.verte === undefined) return;
  m.passes++;
  if (c.commits === undefined) { m.nonMesurees++; return; }
  m.mesurees++;
  if (!c.commits) m.sansCommit++;
  if (!(c.fichiers ?? []).some(fichierDeCode)) m.sansCode++;
}

function compterRun(m, e) {
  m.runs++;
  if (e.sensibles_charge?.length) { m.runsSensibles++; m.sensibles += e.sensibles_charge.length; }
  for (const c of e.corrections ?? []) compterCorrection(m, c);
}

/** Les comptes, au total et par projet (nom du dossier du dépôt). */
export function mesurer(etats) {
  const total = vide(), parProjet = {};
  for (const e of etats) {
    compterRun(total, e);
    const projet = basename(e.repo);
    parProjet[projet] ??= vide();
    compterRun(parProjet[projet], e);
  }
  return { total, parProjet };
}

const part = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '—');
const ligne = (nom, m) => `| ${nom} | ${m.runs} | ${m.passes} | ${m.mesurees} | ${m.sansCode} (${part(m.sansCode, m.mesurees)}) | ${m.sansCommit} | ${m.nonMesurees} | ${m.sensibles} (${m.runsSensibles} runs) |`;

export function rendre(r, dossier, depuis) {
  return [`Passes « porte rouge » de cadence run (${dossier}${depuis ? `, depuis ${depuis}` : ''}) — L842 :`, '',
    '| projet | runs | passes porte rouge | mesurées | sans commit de code | sans commit | non mesurées (avant L842) | sensibles à la charge, sans passe |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(r.parProjet).sort(([a], [b]) => a.localeCompare(b)).map(([n, m]) => ligne(n, m)), ligne('**total**', r.total), '',
    'Avant L842 (étude du 25-11) : 22 corrections de porte sur 54 venaient de tests sensibles à la charge. La part « sans commit de code » ne compte que les passes mesurées.'].join('\n');
}

function principal(argv) {
  const o = { runs: join(dirname(process.cwd()), '.cadence-run') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--runs' || argv[i] === '--depuis') o[argv[i].slice(2)] = argv[++i];
    else throw new Error(`option inconnue : ${argv[i]} (attendu : --runs <dossier>, --depuis <date ISO>, --json)`);
  }
  const r = mesurer(lireEtats(resolve(o.runs), o.depuis));
  return o.json ? JSON.stringify(r, null, 2) : rendre(r, resolve(o.runs), o.depuis);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(principal(process.argv.slice(2))); } catch (err) { console.error(`passes-porte-rouge : ${err.message}`); process.exit(2); }
}
