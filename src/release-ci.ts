import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/** Une étape rejouée est une suite de commandes npm, jouées sans shell (argv), arrêtée au premier code non nul. */
type EtapeCI = { nom: string; commandes: string[][]; sautee?: undefined } | { nom: string; sautee: string; commandes?: undefined };
interface WorkflowCI { fichier: string; etapes: EtapeCI[] }
/** Le commit de version que la release écrira : ses fichiers calculés, plus ceux repris de l'arbre de travail (docs/whats-new.md). */
interface CommitDeVersion { version: string; writes: Map<string, string>; copies: string[] }

/**
 * Revue L698 r1 (D-16) : une liste noire laissait passer « echo … && npm publish », « echo x; git push », pnpm/changeset publish. Seules sont
 * jouées les étapes dont chaque ligne est une commande de la liste blanche, écrite en mots simples (aucun caractère du shell : ni enchaînement,
 * ni tube, ni sous-shell, ni substitution, ni redirection, ni variable). Ces libellés ne servent qu'à dire pourquoi une étape n'est pas jouée.
 */
const RAISONS: [RegExp, string][] = [
  [/(^|[\s;&|(])sudo\s/m, 'commande sudo'],
  [/\bapt(-get)?\s+(install|update|upgrade)\b/, 'installation système'],
  [/\bnpm\s+(install|i|add)\s+(-g|--global)\b/, 'installation globale'],
  [/\bnpm\s+view\b/, 'lit le registre npm'],
  [/\b(pnpm|yarn)\s+publish\b|\bchangeset\s+publish\b|\bsemantic-release\b/, 'publication (pnpm/yarn/changeset/semantic-release)'],
  [/\bgit\b[^\n;&|]*\spush\b/, 'pousse (git push)'],
  [/\bdocker\s+push\b/, 'pousse (docker push)'],
  [/\bdeploy\b/, 'déploiement'],
  [/(^|[\s;&|($])gh\s/m, 'GitHub (gh)'],
  [/\bgit\s+(config\s+--global|fetch)\b/, 'git hors du clone'],
  [/(^|[\s;&|($])(curl|wget)\s/m, 'réseau'],
];
/** Un mot de commande sans rien que bash interprète. */
const CARACTERE_SHELL = /[^\w@%+=:,./\s-]/;
/** Les sous-commandes npm de la liste blanche et les scripts de cycle de vie qu'elles jouent. */
const NPM_RECONNUES: Record<string, (script?: string) => string[]> = {
  ci: () => ['preinstall', 'install', 'postinstall', 'prepare'],
  test: () => ['pretest', 'test', 'posttest'],
  t: () => ['pretest', 'test', 'posttest'],
  run: (s) => [`pre${s}`, s!, `post${s}`],
  'run-script': (s) => [`pre${s}`, s!, `post${s}`],
  pack: () => ['prepack', 'prepare', 'postpack'],
};
/** Un corps de script npm qui publie, pousse, déploie ou appelle le réseau. */
const SCRIPT_PUBLIE = /\b(publish|push|deploy|release|curl|wget|gh|ssh|scp|rsync)\b|\bsemantic-release\b|\bchangeset\b/;
const PUBLISH = /\bnpm\s+publish\b/;
/** Ce que `npm publish` joue avant d'envoyer : prepublishOnly (la suite), puis prepack, prepare (le build) et postpack par `npm pack --dry-run` ; rien ne part. */
const REJEU_PUBLISH = [['npm', 'run', 'prepublishOnly', '--if-present'], ['npm', 'pack', '--dry-run']];
const texteCommandes = (c: string[][]) => c.map((a) => a.join(' ')).join(' && ');

/** Un workflow déclenché par un tag poussé (`on.push.tags`) : celui de la publication. */
function declencheParTag(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  const on = doc.on ?? doc.true; // « on » lu en YAML 1.1 devient la clé true
  return isObject(on) && isObject(on.push) && on.push.tags != null;
}

/**
 * Le script sans ses commentaires ni les arguments de ses `echo` (jusqu'au prochain opérateur, pas jusqu'à la fin de la ligne : « echo x && npm
 * publish » publie) : ne sert qu'à reconnaître une étape de publication, que cadence remplace sans jamais en jouer le texte.
 */
const sansEcho = (run: string) => run.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').replace(/(^|[\s;&|({])echo(\s+("[^"]*"|'[^']*'|[^\s;&|"']+))*/g, '$1')).join('\n');

/** Le premier script de `noms` (et de ceux qu'il appelle par npm run / npm test) qui publie ou pousse, ou undefined. */
function scriptQuiPublie(noms: string[], scripts: Record<string, string>, vus = new Set<string>()): string | undefined {
  for (const nom of noms) {
    const corps = scripts[nom];
    if (corps === undefined || vus.has(nom)) continue;
    vus.add(nom);
    if (SCRIPT_PUBLIE.test(corps)) return nom;
    const appeles = [...corps.matchAll(/\bnpm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|t)\b)/g)].flatMap((m) => (m[1] ? [`pre${m[1]}`, m[1], `post${m[1]}`] : ['pretest', 'test', 'posttest']));
    const fautif = scriptQuiPublie(appeles, scripts, vus);
    if (fautif) return fautif;
  }
  return undefined;
}

/** Une ligne de commande de la liste blanche : son argv, ou la raison du refus. */
function ligneReconnue(ligne: string, scripts: Record<string, string>): string[] | string {
  const argv = ligne.split(/\s+/);
  const sous = argv[0] === 'npm' ? argv[1] : undefined;
  const cycle = sous === undefined ? undefined : NPM_RECONNUES[sous];
  if (!cycle) return `hors liste blanche : « ${sous === undefined ? argv[0] : `npm ${sous}`} » n'est pas une commande reconnue (npm ci, npm test, npm run, npm pack)`;
  const parScript = sous === 'run' || sous === 'run-script';
  const script = parScript ? argv.slice(2).find((a) => !a.startsWith('-')) : undefined;
  if (parScript && !script) return `hors liste blanche : « ${ligne} » sans script`;
  if (script && /^(pre|post)?publish$/.test(script)) return `hors liste blanche : script npm « ${script} »`;
  const fautif = scriptQuiPublie(cycle(script), scripts);
  return fautif ? `le script npm « ${fautif} » publie ou pousse : ${scripts[fautif]}` : argv;
}

/** Les commandes (argv) d'un script `run` si chaque ligne est dans la liste blanche, sinon la raison du refus. */
function commandesReconnues(run: string, scripts: Record<string, string>): string[][] | string {
  const raison = RAISONS.find(([re]) => re.test(run))?.[1];
  if (raison) return raison;
  const car = CARACTERE_SHELL.exec(run);
  if (car) return `hors liste blanche : caractère « ${car[0]} » du shell`;
  const commandes: string[][] = [];
  for (const ligne of run.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const c = ligneReconnue(ligne, scripts);
    if (typeof c === 'string') return c;
    commandes.push(c);
  }
  return commandes;
}

function classer(step: Record<string, unknown>, i: number, scripts: Record<string, string>): EtapeCI {
  const run = typeof step.run === 'string' ? step.run.trim() : '';
  const nom = typeof step.name === 'string' ? step.name : typeof step.uses === 'string' ? step.uses : run.split('\n')[0] || `étape ${i + 1}`;
  if (typeof step.uses === 'string') return { nom, sautee: 'action GitHub' };
  if (!run) return { nom, sautee: 'sans commande run' };
  // Le texte d'une étape de publication n'est jamais joué : cadence joue à sa place ce que npm publish joue avant d'envoyer.
  if (PUBLISH.test(sansEcho(run))) {
    const fautif = scriptQuiPublie(['prepublishOnly', 'prepack', 'prepare', 'postpack'], scripts);
    if (fautif) return { nom, sautee: `le script npm « ${fautif} » publie ou pousse : ${scripts[fautif]}` };
    return { nom: `${nom} → ${texteCommandes(REJEU_PUBLISH)}`, commandes: REJEU_PUBLISH };
  }
  if (step.if !== undefined) return { nom, sautee: `condition if (${String(step.if)})` };
  const c = commandesReconnues(run, scripts);
  return typeof c === 'string' ? { nom, sautee: c } : { nom, commandes: c };
}

function scriptsNpm(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: unknown };
    return isObject(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Les workflows de `.github/workflows` déclenchés par un tag, avec leurs étapes `run` classées : rejouée (commande) ou non (raison). */
export function workflowsCI(root: string): WorkflowCI[] {
  const dir = join(root, WORKFLOWS);
  if (!existsSync(dir)) return [];
  const scripts = scriptsNpm(root);
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
    const etapes = jobs.flatMap((j) => (isObject(j) && Array.isArray(j.steps) ? j.steps : [])).filter(isObject).map((st, i) => classer(st, i, scripts));
    out.push({ fichier: `${WORKFLOWS}/${f}`, etapes });
  }
  return out;
}

const refus = (etape: string, r: Sortie & { signal?: NodeJS.Signals | null }) =>
  new RafError(`release : la CI de publication rejouée dans un clone neuf est rouge, rien n'est écrit — ${etape} (code ${r.status ?? r.signal ?? r.error?.message ?? '?'})\n${queueSortie(texteSortie(r))}`);

/** Variables qui portent un identifiant, ou que la session, un hook ou un script appelant ont posées (CADENCE_*, GIT_*, npm_* ou NPM_*, RAF_*). */
const VARIABLE_RETIREE = /^(CADENCE_|GIT_|RAF_|NPM_|GH_|GITHUB_|SSH_AUTH_SOCK$|SSH_AGENT_PID$|XDG_CONFIG_HOME$)|TOKEN|SECRET|PASSW|CREDENTIAL|API_KEY/i;

/**
 * L'environnement du runner, sans aucun identifiant de l'utilisateur (revue L698 r1, D-16) : HOME vide et temporaire, qui ne porte que
 * l'identité git que la CI se donne (`git config --global user.*`), donc ni ~/.npmrc, ni ~/.gitconfig, ni assistant d'identifiants ;
 * npmrc global vide, ssh désactivé pour git, aucune invite ; NPM_TOKEN, NODE_AUTH_TOKEN, GH_TOKEN, GITHUB_TOKEN et toute variable
 * *TOKEN*, *SECRET*, *PASSWORD*, *CREDENTIAL*, *API_KEY* retirés. Le cache npm (paquets publics, sans identifiant) reste partagé, pour
 * que npm ci ne retélécharge pas tout. Puis `CI` et les variables GITHUB_* que les étapes lisent (le tag dans GITHUB_REF_NAME, RUNNER_TEMP…).
 */
function environnementCI(tmp: string, clone: string, version: string): NodeJS.ProcessEnv {
  const cache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? join(homedir(), '.npm');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARIABLE_RETIREE.test(k)));
  const home = join(tmp, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = cadence-ci\n\temail = cadence-ci@cadence.invalid\n');
  const npmrcGlobal = join(tmp, 'npmrc-global');
  writeFileSync(npmrcGlobal, '');
  const runnerTemp = join(tmp, 'runner-temp');
  mkdirSync(runnerTemp);
  const fichiers: Record<string, string> = {};
  for (const [variable, nom] of [['GITHUB_OUTPUT', 'output'], ['GITHUB_ENV', 'env'], ['GITHUB_PATH', 'path'], ['GITHUB_STEP_SUMMARY', 'step-summary']]) {
    fichiers[variable] = join(tmp, `github-${nom}`);
    writeFileSync(fichiers[variable], '');
  }
  return {
    ...env, ...fichiers, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'false',
    npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: npmrcGlobal, npm_config_cache: cache,
    CI: 'true', GITHUB_REF: `refs/tags/v${version}`, GITHUB_REF_NAME: `v${version}`, GITHUB_REF_TYPE: 'tag', GITHUB_WORKSPACE: clone, RUNNER_TEMP: runnerTemp,
  };
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
  // origin garde ses refs (origin/main, que des tests lisent comme sur la CI) mais pointe vers un chemin qui n'existe pas : ni fetch ni push n'atteint le dépôt du lead.
  const sansDepot = join(dirname(clone), 'aucun-depot');
  const url = g('remote', 'set-url', 'origin', sansDepot);
  if (url.status !== 0) throw refus('git remote set-url origin dans le clone', url);
  const push = g('remote', 'set-url', '--push', 'origin', sansDepot);
  if (push.status !== 0) throw refus('git remote set-url --push origin dans le clone', push);
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

/** Rejoue les étapes reconnues de chaque workflow dans le clone, sans shell ; lève au premier rouge. */
function rejouerCI(tmp: string, clone: string, workflows: WorkflowCI[], version: string, out: (l: string) => void): void {
  const env = environnementCI(tmp, clone, version);
  out('Rejeu dans un environnement sans identifiants : HOME vide et temporaire, ni .npmrc ni configuration git de l\'utilisateur, jetons retirés, origin du clone vers un chemin inexistant');
  for (const wf of workflows) {
    out(`CI de publication rejouée dans un clone neuf du commit de version (${wf.fichier}, tag v${version}) :`);
    for (const e of wf.etapes) {
      if (e.sautee !== undefined) {
        out(`  – non rejouée : ${e.nom} (${e.sautee})`);
        continue;
      }
      const debut = Date.now();
      for (const [cmd, ...args] of e.commandes) {
        const r = spawnSync(cmd, args, { cwd: clone, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: ETAPE_MS });
        if (r.status !== 0) throw refus(`${wf.fichier}, étape « ${e.nom} »`, { ...r, stdout: `$ ${[cmd, ...args].join(' ')}\n${r.stdout ?? ''}` });
      }
      out(`  ✓ ${e.nom} (${Math.round((Date.now() - debut) / 1000)} s)`);
    }
  }
}

/** `--dry-run` : les étapes que la release rejouerait, sans les jouer (la suite complète peut durer plusieurs minutes). */
function listerCI(workflows: WorkflowCI[], out: (l: string) => void): void {
  for (const wf of workflows) {
    out(`CI de publication (${wf.fichier}) : --dry-run ne la rejoue pas ; sans --dry-run, rejouée dans un clone neuf du commit de version :`);
    for (const e of wf.etapes) out(e.sautee !== undefined ? `  – non rejouée : ${e.nom} (${e.sautee})` : `  ▸ ${e.nom}`);
  }
}

/**
 * Ce que cadence release joue avant d'écrire : un clone neuf du commit de version, où les workflows sont lus (revue L698 r1 : pas ceux de
 * l'arbre de travail, qu'un publish.yml modifié non commité ferait diverger de la CI), puis la CI rejouée, ou listée en --dry-run ; sans
 * workflow déclenché par un tag, le dit. Le clone est retiré, vert ou rouge.
 */
export function ciAvantEcriture(root: string, dryRun: boolean, cv: CommitDeVersion, out: (l: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-ci-'));
  const clone = join(tmp, 'clone');
  try {
    clonerCommitDeVersion(root, clone, cv);
    const workflows = workflowsCI(clone);
    if (workflows.length === 0) out('CI de publication : aucun workflow déclenché par un tag dans .github/workflows — rien à rejouer');
    else if (dryRun) listerCI(workflows, out);
    else rejouerCI(tmp, clone, workflows, cv.version, out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
