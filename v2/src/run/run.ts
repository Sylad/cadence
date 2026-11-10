// cadence run : une demande, une session Opus, de bout en bout (plan n°6, 09-11).
// Le produit joue EXACTEMENT un bras mesuré au banc, choisi par l'aiguillage (aiguillage.ts) : brief v2d + hook « lecture obligatoire »
// quand la demande a des références à lire, brief de Claude seul sinon ; mêmes interdictions. Puis : rebase sur la branche de départ, porte complète UNE fois
// (une reprise de la même session si elle est rouge), intégration en avance rapide. Le plan (raf) et deliver restent ceux de la v1.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { argsClaude, creerExecuteur, libererReglages, lire, OUTILS_INTERDITS, type Executeur } from '../bench/bras.js';
import { aiguiller, BRAS_COMPLET, BRAS_LEGER, chemin } from './aiguillage.js';

const PORTE_MS = 30 * 60_000;

export type EtatRun = 'en-cours' | 'attente' | 'sans-commit' | 'echec' | 'conflit' | 'porte-rouge' | 'sans-porte' | 'refus-integration' | 'integre';
export interface Etat { id: string; repo: string; branche: string; cible: string; base: string; worktree: string; fichier: string; demande: string; pieces: string[];
  taille: string; mode: 'complet' | 'leger'; acces_cluster: boolean; session: string; cout_usd: number; etat: EtatRun; detail: string; debut: string; integre?: string }
interface Opts { exec?: Executeur; out: (l: string) => void; sansPorte?: boolean; raf?: string }

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const essaiGit = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const dossierRuns = (repo: string) => join(dirname(repo), '.cadence-run');
const sauver = (e: Etat) => { writeFileSync(e.fichier, JSON.stringify(e, null, 1)); return e; };

// L695 (D-9) : le run tient la branche cible du début à la fin ; le pre-commit de raf (raf hook install) y refuse un commit du lead, qui le ferait
// échouer en avance rapide, et raf add|note|done écrivent dans le plan en attente. Même format que src/repo-held.ts, qui le lit.
const PLAN_EN_ATTENTE = join('.cadence', 'plan-en-attente.yaml');
const RAF = fileURLToPath(new URL('../../../bin/raf.js', import.meta.url));
const fichierTenu = (repo: string) => join(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')), 'cadence', 'tenu', `run-${process.pid}.json`);
function tenir(e: Etat): void {
  const f = fichierTenu(e.repo);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ pid: process.pid, kind: 'run', label: `cadence run ${e.id}`, branch: e.cible, since: new Date().toISOString() }));
}
/** Rend la branche, puis fait appliquer par raf le plan mis en attente pendant le run (raf refuse si un autre programme la tient encore). */
function rendre(e: Etat, o: Opts): void {
  rmSync(fichierTenu(e.repo), { force: true });
  if (!existsSync(join(e.repo, PLAN_EN_ATTENTE))) return;
  const r = spawnSync(process.execPath, [o.raf ?? RAF, 'attente', 'appliquer'], { cwd: e.repo, encoding: 'utf8' });
  const sortie = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  o.out(r.status === 0 ? sortie : `plan en attente non appliqué (${sortie || r.error?.message || `code ${r.status}`}) : raf attente appliquer à la main`);
}

/** Dépendances non suivies (node_modules, .venv) liées en dur dans le worktree : rapide, et les outils les voient chez eux. */
function copierDeps(repo: string, wt: string): void {
  const r = spawnSync('find', [repo, '-maxdepth', '4', '(', '-name', '.git', '-o', '-name', '.cadence-run', ')', '-prune', '-o', '(', '-name', 'node_modules', '-o', '-name', '.venv', ')', '-type', 'd', '-prune', '-print'], { encoding: 'utf8' });
  for (const d of r.stdout.split('\n').filter(Boolean)) {
    const cible = join(wt, d.slice(repo.length + 1));
    if (existsSync(cible)) continue;
    mkdirSync(dirname(cible), { recursive: true });
    if (spawnSync('cp', ['-al', d, cible]).status !== 0) spawnSync('cp', ['-a', d, cible]);
  }
}

const orchestrate = (repo: string): { test?: string; build?: string; prodAccess?: boolean } =>
  existsSync(join(repo, 'cadence.yaml')) ? (parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) as { orchestrate?: object } | null)?.orchestrate ?? {} : {};
function commandesDeCadenceYaml(repo: string): string[] {
  const o = orchestrate(repo);
  return [o.test, o.build].filter((c): c is string => typeof c === 'string' && !!c.trim());
}
function jouerPorte(cmds: string[], cwd: string): { ok: boolean; sortie: string } {
  for (const c of cmds) {
    const r = spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', timeout: PORTE_MS, maxBuffer: 64 << 20 });
    if (r.status !== 0) return { ok: false, sortie: `$ ${c}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000)}${r.error ? `\n${r.error.message}` : ''}` };
  }
  return { ok: true, sortie: '' };
}

function session(e: Etat, prompt: string, o: Opts): boolean {
  const exec = o.exec ?? creerExecuteur('claude', 4 * 3600_000);
  // orchestrate.prodAccess (comme les vagues de la v1) : sans lui, ni kubectl, ni helm, ni KUBECONFIG ; avec lui, la session joue le banc du projet
  const env = { ...process.env, CADENCE_CLONE: e.worktree, CADENCE_PIECES: JSON.stringify(e.pieces), CADENCE_BANC_RACINE: dossierRuns(e.repo), ...(e.acces_cluster ? {} : { KUBECONFIG: '/dev/null' }) };
  const interdits = e.acces_cluster ? OUTILS_INTERDITS.filter((x) => !/kubectl|helm/.test(x)) : OUTILS_INTERDITS;
  const r = lire(exec(['-p', prompt, ...(e.session ? ['--resume', e.session] : []), ...argsClaude(e.mode === 'leger' ? BRAS_LEGER : BRAS_COMPLET, e.worktree, interdits)], { cwd: e.worktree, env }));
  e.session = r.session || e.session; e.cout_usd += r.cout;
  if (r.echec) { e.etat = 'echec'; e.detail = r.echec; return false; }
  if (r.resultat) o.out(`session : ${r.resultat.slice(-1500)}`);
  return true;
}

/** Après chaque passage de session : question, commits, rebase, porte (une reprise), intégration. */
function suite(e: Etat, o: Opts): Etat {
  const q = `${e.worktree}.question.md`;
  if (existsSync(q)) { e.etat = 'attente'; e.detail = readFileSync(q, 'utf8'); rmSync(q); o.out(`question (réponds : cadence run --reponse ${e.id} "…") :\n${e.detail}`); return fin(e, o); }
  if (git(e.worktree, 'rev-list', '--count', `${e.base}..HEAD`) === '0') { e.etat = 'sans-commit'; e.detail = 'la session n\'a rien commité'; return fin(e, o); }
  const cible = git(e.repo, 'rev-parse', e.cible);
  if (essaiGit(e.worktree, 'rebase', '-q', cible).status !== 0) {
    essaiGit(e.worktree, 'rebase', '--abort'); e.etat = 'conflit'; e.detail = `conflit au rebase sur ${e.cible}`; return fin(e, o);
  }
  const cmds = commandesDeCadenceYaml(e.repo);
  if (!cmds.length && !o.sansPorte) { e.etat = 'sans-porte'; e.detail = 'cadence.yaml ne déclare ni orchestrate.test ni orchestrate.build : relance avec --sans-porte pour intégrer quand même'; return fin(e, o); }
  // Porte complète : une fois ; rouge, la même session corrige une fois et la porte est rejouée (C3 : un seul site de porte).
  for (let essai = 0; ; essai++) {
    const p = jouerPorte(cmds, e.worktree);
    if (p.ok) break;
    if (essai === 1) { e.etat = 'porte-rouge'; e.detail = p.sortie; return fin(e, o); }
    o.out('porte rouge : reprise de la session pour corriger');
    if (!session(e, `La porte complète est rouge après ton travail :\n${p.sortie}\nCorrige la cause (sans affaiblir aucun test), commite, puis dis « fini ».`, o)) return fin(e, o);
  }
  const br = git(e.worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
  const actuelle = essaiGit(e.repo, 'symbolic-ref', '-q', '--short', 'HEAD').stdout.trim();
  const m = actuelle === e.cible ? essaiGit(e.repo, 'merge', '-q', '--ff-only', br) : essaiGit(e.repo, 'fetch', '-q', '.', `${br}:${e.cible}`);
  if (m.status !== 0) { e.etat = 'refus-integration'; e.detail = `${m.stderr}`.trim() || 'avance rapide impossible'; return fin(e, o); }
  e.integre = git(e.repo, 'rev-parse', '--short', e.cible); e.etat = 'integre'; e.detail = '';
  const registre = registreOuvert(e.worktree);
  essaiGit(e.repo, 'worktree', 'remove', '--force', e.worktree); essaiGit(e.repo, 'branch', '-D', br);
  libererReglages(e.worktree); rmSync(`${e.worktree}.reglages`, { recursive: true, force: true });
  return fin(e, o, registre);
}

function registreOuvert(wt: string): string[] {
  const d = join(wt, '.cadence', 'demandes');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { const j = JSON.parse(readFileSync(join(d, f), 'utf8')) as { id?: string; etat?: string; texte?: string }; return j.etat === 'ouverte' ? [`${j.id ?? f} ouverte : ${j.texte ?? ''}`] : []; } catch { return [`${f} illisible`]; }
  });
}

function fin(e: Etat, o: Opts, registre = registreOuvert(e.worktree)): Etat {
  sauver(e);
  rendre(e, o);
  const duree = Math.round((Date.now() - Date.parse(e.debut)) / 1000);
  o.out(`cadence run ${e.id} : ${e.etat}${e.integre ? ` (${e.cible} = ${e.integre})` : ''} · ${duree} s · ${e.cout_usd.toFixed(2)} $${e.detail ? `\n${e.detail}` : ''}`);
  for (const r of registre) o.out(`registre : ${r}`);
  if (e.etat !== 'integre') o.out(`worktree gardé : ${e.worktree} (état : ${e.fichier})`);
  return e;
}

export function executerRun(a: { repo: string; demande: string; pieces?: string[]; taille?: string; complet?: boolean; lot?: string; exec?: Executeur; out: (l: string) => void; sansPorte?: boolean; raf?: string }): Etat {
  const repo = git(a.repo, 'rev-parse', '--show-toplevel'), cible = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${process.pid}`;
  const runs = dossierRuns(repo), worktree = join(runs, `${basename(repo)}-${id}`);
  mkdirSync(runs, { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `cadence/run-${id}`, worktree, 'HEAD');
  copierDeps(repo, worktree);
  const aig = aiguiller(a.demande, worktree, a.pieces ?? [], a.complet);
  const e: Etat = { id, repo, branche: `cadence/run-${id}`, cible, base: git(worktree, 'rev-parse', 'HEAD'), worktree, fichier: join(runs, `${basename(repo)}-${id}.json`),
    demande: a.demande, pieces: aig.pieces.map((p) => chemin(worktree, p)), taille: a.taille ?? 'fonction', mode: aig.mode, acces_cluster: orchestrate(worktree).prodAccess === true, session: '', cout_usd: 0, etat: 'en-cours', detail: '', debut: new Date().toISOString() };
  sauver(e); tenir(e);
  a.out(`cadence run ${id} : session Opus en mode ${aig.mode} (${aig.raison}) dans ${worktree}`);
  // La ligne « Taille » du brief sert au banc (taille déclarée) ; dans un vrai dépôt, elle casserait commitlint : retirée.
  const demande = a.lot ? `${a.demande}\n\nLot du plan : ${a.lot}. Cite-le dans chaque message de commit, selon les conventions de commit du dépôt (par exemple feat(${a.lot}): …).` : a.demande;
  const brief = readFileSync(aig.bras.brief, 'utf8').split('\n').filter((l) => !l.startsWith('- Taille fixée par le gardien')).join('\n').replaceAll('{{DEMANDE}}', demande).replaceAll('{{CLONE}}', worktree)
    .replaceAll('{{QUESTION}}', `${worktree}.question.md`).replaceAll('{{BASE}}', e.base).replaceAll('{{TAILLE}}', e.taille);
  const o = { exec: a.exec, out: a.out, sansPorte: a.sansPorte, raf: a.raf };
  return session(e, brief, o) ? suite(e, o) : fin(e, o);
}

/** Reprend un run en attente (question) ou rendu (porte rouge, conflit, sans porte) : la réponse va à la même session. */
export function repondreRun(id: string, repo: string, reponse: string, o: Opts): Etat {
  const racine = git(repo, 'rev-parse', '--show-toplevel');
  const f = join(dossierRuns(racine), `${basename(racine)}-${id}.json`);
  if (!existsSync(f)) throw new Error(`cadence run : run inconnu : ${id} (${f})`);
  const e = JSON.parse(readFileSync(f, 'utf8')) as Etat;
  if (e.etat === 'integre') throw new Error(`cadence run : ${id} est déjà intégré`);
  e.etat = 'en-cours'; tenir(e);
  return session(e, `Réponse de Sylvain : ${reponse}`, o) ? suite(e, o) : fin(e, o);
}
