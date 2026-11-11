import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { RafError } from './plan.js';
import { isObject } from './yaml-keys.js';
import { queueSortie, texteSortie, type Sortie } from './release-fumee.js';

/**
 * L698 (D-14, erreur 2 du relevé du 10-11, suite de L696) : 7 des 10 versions cassées du 28-10 au 10-11 l'ont été dans la CI de
 * publication (publish.yml), que la porte jouée dans l'arbre du lead et la fumée du paquet installé ne couvrent pas : un fichier non
 * suivi présent dans tout arbre local et absent du checkout de la CI (1.25.0), un test qui lit le dernier tag (1.34.0), un cliquet sans
 * branche (1.42.0), un test documentaire (1.22.0). Avant tout écrit, cadence release rejoue dans un clone neuf du commit de version
 * (HEAD + les fichiers de version, tagué v<version> comme le checkout de la CI) les étapes `run` du workflow déclenché par un tag :
 * ce que la CI jouerait sur ce commit, sans publier ; une étape rouge refuse la release avec la commande et sa sortie ; le clone est retiré.
 */

const ETAPE_MS = 30 * 60_000;
const WORKFLOWS = '.github/workflows';

type EtapeCI = { nom: string; commande: string; sautee?: undefined } | { nom: string; sautee: string; commande?: undefined };
interface WorkflowCI { fichier: string; etapes: EtapeCI[] }
/** Le commit de version que la release écrira : ses fichiers calculés, plus ceux repris de l'arbre de travail (docs/whats-new.md). */
interface CommitDeVersion { version: string; writes: Map<string, string>; copies: string[] }

/** Ce qu'un poste de travail ne rejoue pas : système, installation globale, registre npm, GitHub, git hors du clone. */
const NON_REJOUABLES: [RegExp, string][] = [
  [/(^|[\s;&|(])sudo\s/m, 'commande sudo'],
  [/\bapt(-get)?\s+(install|update|upgrade)\b/, 'installation système'],
  [/\bnpm\s+(install|i|add)\s+(-g|--global)\b/, 'installation globale'],
  [/\bnpm\s+view\b/, 'lit le registre npm'],
  [/(^|[\s;&|($])gh\s/m, 'GitHub (gh)'],
  [/\bgit\s+(config\s+--global|push|fetch)\b/, 'git hors du clone'],
  [/(^|[\s;&|($])(curl|wget)\s/m, 'réseau'],
];
const PUBLISH = /\bnpm\s+publish\b/;
/** Ce que `npm publish` joue avant d'envoyer : prepublishOnly (la suite), puis prepack, prepare (le build) et postpack par `npm pack --dry-run` ; rien ne part. */
const REJEU_PUBLISH = 'npm run prepublishOnly --if-present && npm pack --dry-run';

/** Un workflow déclenché par un tag poussé (`on.push.tags`) : celui de la publication. */
function declencheParTag(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  const on = doc.on ?? doc.true; // « on » lu en YAML 1.1 devient la clé true
  return isObject(on) && isObject(on.push) && on.push.tags != null;
}

/** Les commandes d'un script, sans ses commentaires ni le texte de ses `echo` (« npm publish est sauté » dans un message n'est pas une publication). */
const commandes = (run: string) => run.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').replace(/(^|[\s;&|({])echo\s.*$/, '$1')).join('\n');

function classer(step: Record<string, unknown>, i: number): EtapeCI {
  const run = typeof step.run === 'string' ? step.run.trim() : '';
  const nom = typeof step.name === 'string' ? step.name : typeof step.uses === 'string' ? step.uses : run.split('\n')[0] || `étape ${i + 1}`;
  if (typeof step.uses === 'string') return { nom, sautee: 'action GitHub' };
  if (!run) return { nom, sautee: 'sans commande run' };
  const cmds = commandes(run);
  if (PUBLISH.test(cmds)) return { nom: `${nom} → ${REJEU_PUBLISH}`, commande: REJEU_PUBLISH };
  if (step.if !== undefined) return { nom, sautee: `condition if (${String(step.if)})` };
  for (const [re, raison] of NON_REJOUABLES) if (re.test(cmds)) return { nom, sautee: raison };
  return { nom, commande: run };
}

/** Les workflows de `.github/workflows` déclenchés par un tag, avec leurs étapes `run` classées : rejouée (commande) ou non (raison). */
export function workflowsCI(root: string): WorkflowCI[] {
  const dir = join(root, WORKFLOWS);
  if (!existsSync(dir)) return [];
  const out: WorkflowCI[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      throw new RafError(`release : ${WORKFLOWS}/${f} illisible : ${(e as Error).message.split('\n')[0]}`);
    }
    if (!declencheParTag(doc)) continue;
    const jobs = isObject((doc as Record<string, unknown>).jobs) ? Object.values((doc as Record<string, unknown>).jobs as Record<string, unknown>) : [];
    const etapes = jobs.flatMap((j) => (isObject(j) && Array.isArray(j.steps) ? j.steps : [])).filter(isObject).map(classer);
    out.push({ fichier: `${WORKFLOWS}/${f}`, etapes });
  }
  return out;
}

const refus = (etape: string, r: Sortie) =>
  new RafError(`release : la CI de publication rejouée dans un clone neuf est rouge, rien n'est écrit — ${etape} (code ${r.status ?? r.error?.message ?? '?'})\n${queueSortie(texteSortie(r))}`);

/**
 * L'environnement du runner, moins ce qui vient d'ici : ni variables CADENCE_* d'une session ou d'un run, ni GIT_* d'un hook, ni npm_* d'un
 * script npm appelant, ni RAF_* ; `CI` et les variables GITHUB_* que les étapes lisent (le tag dans GITHUB_REF_NAME, RUNNER_TEMP, GITHUB_OUTPUT).
 */
function environnementCI(tmp: string, clone: string, version: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CADENCE_|GIT_|npm_|RAF_)/.test(k)));
  const runnerTemp = join(tmp, 'runner-temp');
  mkdirSync(runnerTemp);
  const fichiers: Record<string, string> = {};
  for (const [variable, nom] of [['GITHUB_OUTPUT', 'output'], ['GITHUB_ENV', 'env'], ['GITHUB_PATH', 'path'], ['GITHUB_STEP_SUMMARY', 'step-summary']]) {
    fichiers[variable] = join(tmp, `github-${nom}`);
    writeFileSync(fichiers[variable], '');
  }
  return { ...env, ...fichiers, CI: 'true', GITHUB_REF: `refs/tags/v${version}`, GITHUB_REF_NAME: `v${version}`, GITHUB_REF_TYPE: 'tag', GITHUB_WORKSPACE: clone, RUNNER_TEMP: runnerTemp };
}

/** Le clone neuf, détaché sur HEAD, avec le commit de version et son tag : ce que le checkout de la CI verra. */
function clonerCommitDeVersion(root: string, clone: string, cv: CommitDeVersion): void {
  const g = (...a: string[]) => spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a], { cwd: clone, encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) throw refus('git rev-parse HEAD', head);
  const cl = spawnSync('git', ['clone', '-q', '--no-hardlinks', root, clone], { encoding: 'utf8' });
  if (cl.status !== 0) throw refus('git clone --no-hardlinks du dépôt', cl);
  const co = g('checkout', '-q', '--detach', head.stdout.trim());
  if (co.status !== 0) throw refus(`git checkout ${head.stdout.trim().slice(0, 12)} dans le clone (HEAD n'est pas sur une branche ?)`, co);
  const fichiers: string[] = [];
  for (const [f, texte] of cv.writes) {
    mkdirSync(dirname(join(clone, f)), { recursive: true });
    writeFileSync(join(clone, f), texte);
    fichiers.push(f);
  }
  for (const f of cv.copies.filter((c) => existsSync(join(root, c)))) {
    mkdirSync(dirname(join(clone, f)), { recursive: true });
    copyFileSync(join(root, f), join(clone, f));
    fichiers.push(f);
  }
  const add = g('add', '--', ...fichiers);
  if (add.status !== 0) throw refus('git add des fichiers de version dans le clone', add);
  const ci = g('-c', 'user.name=cadence release', '-c', 'user.email=release@cadence.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `release: ${cv.version}`);
  if (ci.status !== 0) throw refus('git commit de version dans le clone', ci);
  const tag = g('-c', 'tag.gpgsign=false', 'tag', `v${cv.version}`);
  if (tag.status !== 0) throw refus(`git tag v${cv.version} dans le clone`, tag);
}

/** Rejoue les étapes rejouables de chaque workflow dans un clone neuf du commit de version ; lève au premier rouge ; retire le clone, vert ou rouge. */
function rejouerCI(root: string, workflows: WorkflowCI[], cv: CommitDeVersion, out: (l: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-ci-'));
  const clone = join(tmp, 'clone');
  try {
    clonerCommitDeVersion(root, clone, cv);
    const env = environnementCI(tmp, clone, cv.version);
    for (const wf of workflows) {
      out(`CI de publication rejouée dans un clone neuf du commit de version (${wf.fichier}, tag v${cv.version}) :`);
      for (const e of wf.etapes) {
        if (e.sautee !== undefined) {
          out(`  – non rejouée : ${e.nom} (${e.sautee})`);
          continue;
        }
        const debut = Date.now();
        // bash -e, le shell par défaut d'une étape `run` sur ubuntu-latest
        const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', e.commande], { cwd: clone, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: ETAPE_MS });
        if (r.status !== 0) throw refus(`${wf.fichier}, étape « ${e.nom} »`, { ...r, stdout: `$ ${e.commande.replace(/\n/g, '\n  ')}\n${r.stdout ?? ''}` });
        out(`  ✓ ${e.nom} (${Math.round((Date.now() - debut) / 1000)} s)`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** `--dry-run` : les étapes que la release rejouerait, sans les jouer (la suite complète peut durer plusieurs minutes). */
function listerCI(workflows: WorkflowCI[], out: (l: string) => void): void {
  for (const wf of workflows) {
    out(`CI de publication (${wf.fichier}) : --dry-run ne la rejoue pas ; sans --dry-run, rejouée dans un clone neuf du commit de version :`);
    for (const e of wf.etapes) out(e.sautee !== undefined ? `  – non rejouée : ${e.nom} (${e.sautee})` : `  ▸ ${e.nom}`);
  }
}

/** Ce que cadence release joue avant d'écrire : la CI rejouée (ou listée en --dry-run) ; sans workflow déclenché par un tag, le dit. */
export function ciAvantEcriture(root: string, dryRun: boolean, cv: CommitDeVersion, out: (l: string) => void): void {
  const workflows = workflowsCI(root);
  if (workflows.length === 0) out('CI de publication : aucun workflow déclenché par un tag dans .github/workflows — rien à rejouer');
  else if (dryRun) listerCI(workflows, out);
  else rejouerCI(root, workflows, cv, out);
}
