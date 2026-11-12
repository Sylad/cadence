import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
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

/** Une étape rejouée est une suite de commandes npm, jouées sans shell (argv) dans `dossier` du clone (son working-directory), arrêtée au premier code non nul. */
type EtapeCI = { nom: string; commandes: string[][]; dossier?: string; sautee?: undefined } | { nom: string; sautee: string; commandes?: undefined; dossier?: undefined };
interface WorkflowCI { fichier: string; etapes: EtapeCI[] }
/** Le commit de version que la release écrira : ses fichiers calculés, plus ceux repris de l'arbre de travail (docs/whats-new.md). */
interface CommitDeVersion { version: string; writes: Map<string, string>; removes?: string[]; copies: string[] }

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
/**
 * Les sous-commandes npm de la liste blanche et les scripts de cycle de vie qu'elles jouent. Revue L698 r2 (D-17), mesuré avec npm 12.2 :
 * npm ci joue aussi prepublish, preprepare et postprepare, et npm pack preprepare et postprepare autour de prepare.
 */
const CYCLE_CI = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const NPM_RECONNUES: Record<string, (script?: string) => string[]> = {
  ci: () => CYCLE_CI,
  test: () => ['pretest', 'test', 'posttest'],
  t: () => ['pretest', 'test', 'posttest'],
  run: (s) => [`pre${s}`, s!, `post${s}`],
  'run-script': (s) => [`pre${s}`, s!, `post${s}`],
  pack: () => ['prepack', 'preprepare', 'prepare', 'postprepare', 'postpack'],
};
/** Un corps de script npm qui publie, pousse, déploie ou appelle le réseau. */
const SCRIPT_PUBLIE = /\b(publish|push|deploy|release|curl|wget|gh|ssh|scp|sftp|rsync|kubectl|helm)\b|\bsemantic-release\b|\bchangeset\b/;
/** Les options npm qui changent de paquet (workspaces, --prefix) ou de configuration (--userconfig, --globalconfig vers un chemin du poste). */
const OPTION_REFUSEE = /^(-w|--workspaces?|--include-workspace-root|--prefix|-C|--userconfig|--globalconfig)(=|$)/;
const PUBLISH = /\bnpm\s+publish\b/;
/** Ce que `npm publish` joue avant d'envoyer : prepublishOnly (la suite), puis prepack, prepare (le build) et postpack par `npm pack --dry-run` ; rien ne part. */
const REJEU_PUBLISH = [['npm', 'run', 'prepublishOnly', '--if-present'], ['npm', 'pack', '--dry-run']];
const CYCLE_PUBLISH = ['prepublishOnly', 'prepack', 'preprepare', 'prepare', 'postprepare', 'postpack'];
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

/** Les scripts npm d'un dossier : ceux de son package.json, et ceux des paquets de ses workspaces (npm ci joue leur cycle de vie aussi). */
interface PaquetsNpm { racine: Record<string, string>; workspaces: [string, Record<string, string>][] }

/** La raison du refus si un script de `noms` (dans le paquet, ou, pour npm ci, dans un paquet de workspace) publie ou pousse. */
function raisonScripts(noms: string[], p: PaquetsNpm, workspaces: boolean): string | undefined {
  const fautif = scriptQuiPublie(noms, p.racine);
  if (fautif) return `le script npm « ${fautif} » publie ou pousse : ${p.racine[fautif]}`;
  for (const [chemin, scripts] of workspaces ? p.workspaces : []) {
    const f = scriptQuiPublie(noms, scripts);
    if (f) return `le script npm « ${f} » de ${chemin} publie ou pousse : ${scripts[f]}`;
  }
  return undefined;
}

/** Une ligne de commande de la liste blanche : son argv, ou la raison du refus. */
function ligneReconnue(ligne: string, p: PaquetsNpm): string[] | string {
  const argv = ligne.split(/\s+/);
  const sous = argv[0] === 'npm' ? argv[1] : undefined;
  const cycle = sous === undefined ? undefined : NPM_RECONNUES[sous];
  if (!cycle) return `hors liste blanche : « ${sous === undefined ? argv[0] : `npm ${sous}`} » n'est pas une commande reconnue (npm ci, npm test, npm run, npm pack)`;
  const option = argv.find((a) => OPTION_REFUSEE.test(a));
  if (option) return `hors liste blanche : option « ${option} » (autre paquet ou autre configuration npm)`;
  const parScript = sous === 'run' || sous === 'run-script';
  const script = parScript ? argv.slice(2).find((a) => !a.startsWith('-')) : undefined;
  if (parScript && !script) return `hors liste blanche : « ${ligne} » sans script`;
  if (script && /^(pre|post)?publish$/.test(script)) return `hors liste blanche : script npm « ${script} »`;
  return raisonScripts(cycle(script), p, sous === 'ci') ?? argv;
}

/** Les commandes (argv) d'un script `run` si chaque ligne est dans la liste blanche, sinon la raison du refus. */
function commandesReconnues(run: string, p: PaquetsNpm): string[][] | string {
  const raison = RAISONS.find(([re]) => re.test(run))?.[1];
  if (raison) return raison;
  const car = CARACTERE_SHELL.exec(run);
  if (car) return `hors liste blanche : caractère « ${car[0]} » du shell`;
  const commandes: string[][] = [];
  for (const ligne of run.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const c = ligneReconnue(ligne, p);
    if (typeof c === 'string') return c;
    commandes.push(c);
  }
  return commandes;
}

/** Le job d'une étape : son nom, son `if:`, et le working-directory par défaut (defaults.run du job, sinon du workflow). */
interface JobCI { nom: string; si: unknown; dossier: unknown }

/**
 * Le dossier du clone où l'étape tourne (revue L698 r2, D-17 : une étape `npm test` sous `working-directory: packages/a` était jouée à la
 * racine, un verdict faux) : '' pour la racine, ou la raison du refus — un chemin calculé, absolu, qui sort du clone, ou absent du commit.
 */
function dossierEtape(root: string, wd: unknown): string | { refus: string } {
  if (wd === undefined) return '';
  const texte = String(wd);
  if (texte.includes('${{')) return { refus: `working-directory « ${texte} » calculé (\${{ }}) : non rejouable hors de la CI` };
  const n = normalize(texte).replace(/\/+$/, '');
  if (isAbsolute(texte) || n === '..' || n.startsWith('../')) return { refus: `working-directory « ${texte} » hors du clone` };
  const d = n === '.' ? '' : n;
  if (d && !(existsSync(join(root, d)) && statSync(join(root, d)).isDirectory())) return { refus: `working-directory « ${texte} » absent du commit` };
  return d;
}

function classer(step: Record<string, unknown>, i: number, root: string, job: JobCI): EtapeCI {
  const run = typeof step.run === 'string' ? step.run.trim() : '';
  const nom = typeof step.name === 'string' ? step.name : typeof step.uses === 'string' ? step.uses : run.split('\n')[0] || `étape ${i + 1}`;
  // Un job sous condition (if: github.repository == …, une branche, un événement) n'est pas rejoué : cadence ne sait pas l'évaluer.
  if (job.si !== undefined) return { nom, sautee: `job « ${job.nom} » sous condition if (${String(job.si)})` };
  if (typeof step.uses === 'string') return { nom, sautee: 'action GitHub' };
  if (!run) return { nom, sautee: 'sans commande run' };
  const d = dossierEtape(root, step['working-directory'] ?? job.dossier);
  if (typeof d !== 'string') return { nom, sautee: d.refus };
  const dossier = d || undefined;
  const p = paquetsNpm(join(root, d));
  // Le texte d'une étape de publication n'est jamais joué : cadence joue à sa place ce que npm publish joue avant d'envoyer.
  if (PUBLISH.test(sansEcho(run))) {
    const raison = raisonScripts(CYCLE_PUBLISH, p, false);
    if (raison) return { nom, sautee: raison };
    return { nom: `${nom} → ${texteCommandes(REJEU_PUBLISH)}`, commandes: REJEU_PUBLISH, dossier };
  }
  if (step.if !== undefined) return { nom, sautee: `condition if (${String(step.if)})` };
  const c = commandesReconnues(run, p);
  return typeof c === 'string' ? { nom, sautee: c } : { nom, commandes: c, dossier };
}

function lirePaquet(dir: string): { scripts: Record<string, string>; workspaces: string[] } {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: unknown; workspaces?: unknown };
    const scripts = isObject(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : isObject(pkg.workspaces) && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : [];
    return { scripts, workspaces: ws.filter((w): w is string => typeof w === 'string') };
  } catch {
    return { scripts: {}, workspaces: [] };
  }
}

/** Les dossiers d'un motif de workspaces : un chemin, ou un chemin qui finit par `*` ou `**` (ses sous-dossiers directs). */
function dossiersWorkspace(dir: string, motif: string): string[] {
  const m = motif.replace(/\/+$/, '').replace(/^\.\//, '');
  const etoile = /\/\*{1,2}$/.exec(m);
  if (!etoile) return existsSync(join(dir, m, 'package.json')) ? [m] : [];
  const parent = m.slice(0, etoile.index);
  if (!existsSync(join(dir, parent))) return [];
  return readdirSync(join(dir, parent), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, parent, e.name, 'package.json'))).map((e) => `${parent}/${e.name}`).sort();
}

function paquetsNpm(dir: string): PaquetsNpm {
  const racine = lirePaquet(dir);
  const workspaces = racine.workspaces.flatMap((w) => dossiersWorkspace(dir, w)).map((w): [string, Record<string, string>] => [w, lirePaquet(join(dir, w)).scripts]);
  return { racine: racine.scripts, workspaces };
}

/** `defaults.run.working-directory` d'un workflow ou d'un job. */
const defautWd = (o: Record<string, unknown>): unknown => (isObject(o.defaults) && isObject(o.defaults.run) ? o.defaults.run['working-directory'] : undefined);

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
    const d = doc as Record<string, unknown>;
    const wdWorkflow = defautWd(d);
    const jobs = isObject(d.jobs) ? Object.entries(d.jobs) : [];
    const etapes = jobs.flatMap(([nom, j]) => {
      if (!isObject(j) || !Array.isArray(j.steps)) return [];
      const job: JobCI = { nom, si: j.if, dossier: defautWd(j) ?? wdWorkflow };
      return j.steps.filter(isObject).map((st, i) => classer(st, i, root, job));
    });
    out.push({ fichier: `${WORKFLOWS}/${f}`, etapes });
  }
  return out;
}

const refus = (etape: string, r: Sortie & { signal?: NodeJS.Signals | null }) =>
  new RafError(`release : la CI de publication rejouée dans un clone neuf est rouge, rien n'est écrit — ${etape} (code ${r.status ?? r.signal ?? r.error?.message ?? '?'})\n${queueSortie(texteSortie(r))}`);

/**
 * Revue L698 r2 (D-17) : une liste noire laissait passer KUBECONFIG (le cluster de production), DOCKER_HOST, NETRC, AWS_*… Seules ces
 * variables de l'appelant sont transmises ; toutes les autres sont retirées. Aucune ne porte d'accès : le chemin des commandes, la langue,
 * le terminal, le fuseau, le dossier temporaire, le nom de l'utilisateur, son shell, et le refus du cache de compilation de node.
 */
const VARIABLE_TRANSMISE = /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|TMPDIR|USER|LOGNAME|SHELL|NODE_DISABLE_COMPILE_CACHE)$/;
/**
 * Commandes qui atteignent une machine avec les accès de l'utilisateur sans passer par HOME (ssh lit ~/.ssh par passwd) : coupées en tête du
 * PATH. rsync n'y est pas : la suite de cadence s'en sert en local (scripts/mise-en-service.mjs), et un rsync distant lance `ssh` par le PATH,
 * donc la cale ; scp et sftp, eux, lancent ssh par son chemin absolu.
 */
const COMMANDES_COUPEES = ['ssh', 'scp', 'sftp', 'kubectl', 'helm', 'gh', 'docker'];

/**
 * L'environnement du runner, sans aucun accès de l'utilisateur (revues L698 r1 et r2, D-16 et D-17) : seules les variables de
 * VARIABLE_TRANSMISE passent ; HOME vide et temporaire, qui ne porte que l'identité git que la CI se donne (`git config --global user.*`),
 * donc ni ~/.npmrc, ni ~/.gitconfig, ni ~/.kube, ni assistant d'identifiants ; XDG_CONFIG_HOME et GIT_CONFIG_GLOBAL dans ce HOME, configuration
 * git système ignorée, ssh désactivé pour git, aucune invite ; npmrc global vide ; les COMMANDES_COUPEES remplacées en tête du PATH par une
 * cale qui échoue. Le cache npm (paquets publics, sans identifiant) reste partagé, pour que npm ci ne retélécharge pas tout. Puis `CI` et
 * les variables GITHUB_* que les étapes lisent (le tag dans GITHUB_REF_NAME, RUNNER_TEMP…).
 */
function environnementCI(tmp: string, clone: string, version: string): NodeJS.ProcessEnv {
  const cache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? join(homedir(), '.npm');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => VARIABLE_TRANSMISE.test(k)));
  const home = join(tmp, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = cadence-ci\n\temail = cadence-ci@cadence.invalid\n');
  const coupees = join(tmp, 'coupees');
  mkdirSync(coupees);
  for (const c of COMMANDES_COUPEES) {
    writeFileSync(join(coupees, c), `#!/bin/sh\necho "cadence release : ${c} est coupé pendant le rejeu de la CI de publication (aucun accès de l'utilisateur)" >&2\nexit 126\n`);
    chmodSync(join(coupees, c), 0o755);
  }
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
    ...env, ...fichiers, PATH: env.PATH ? `${coupees}:${env.PATH}` : coupees, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'false',
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
  // L679 : les fragments du CHANGELOG assemblés dans la section sont retirés par le commit de version, dans le clone comme chez le lead.
  for (const f of cv.removes ?? []) {
    rmSync(join(clone, f), { force: true });
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

/** Joue une étape reconnue dans son dossier du clone, sans shell ; lève au premier code non nul. */
function jouerEtape(fichier: string, e: EtapeCI & { commandes: string[][] }, clone: string, env: NodeJS.ProcessEnv, out: (l: string) => void): void {
  const debut = Date.now();
  const dans = e.dossier ? ` (dans ${e.dossier})` : '';
  for (const [cmd, ...args] of e.commandes) {
    const r = spawnSync(cmd, args, { cwd: join(clone, e.dossier ?? ''), env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: ETAPE_MS });
    if (r.status !== 0) throw refus(`${fichier}, étape « ${e.nom} »${dans}`, { ...r, stdout: `$ ${[cmd, ...args].join(' ')}\n${r.stdout ?? ''}` });
  }
  out(`  ✓ ${e.nom}${dans} (${Math.round((Date.now() - debut) / 1000)} s)`);
}

/** Rejoue les étapes reconnues de chaque workflow dans le clone, sans shell ; lève au premier rouge. */
function rejouerCI(tmp: string, clone: string, workflows: WorkflowCI[], version: string, out: (l: string) => void): void {
  const env = environnementCI(tmp, clone, version);
  out(`Rejeu dans un environnement sans identifiants : HOME vide et temporaire, variables transmises : liste blanche (PATH, LANG, LC_*, TERM, TZ, TMPDIR, USER, LOGNAME, SHELL, NODE_DISABLE_COMPILE_CACHE), ${COMMANDES_COUPEES.join(', ')} coupés, ni .npmrc ni configuration git de l'utilisateur, origin du clone vers un chemin inexistant`);
  for (const wf of workflows) {
    out(`CI de publication rejouée dans un clone neuf du commit de version (${wf.fichier}, tag v${version}) :`);
    for (const e of wf.etapes) {
      if (e.sautee !== undefined) out(`  – non rejouée : ${e.nom} (${e.sautee})`);
      else jouerEtape(wf.fichier, e, clone, env, out);
    }
  }
}

/** `--dry-run` : les étapes que la release rejouerait, sans les jouer (la suite complète peut durer plusieurs minutes). */
function listerCI(workflows: WorkflowCI[], out: (l: string) => void): void {
  for (const wf of workflows) {
    out(`CI de publication (${wf.fichier}) : --dry-run ne la rejoue pas ; sans --dry-run, rejouée dans un clone neuf du commit de version :`);
    for (const e of wf.etapes) out(e.sautee !== undefined ? `  – non rejouée : ${e.nom} (${e.sautee})` : `  ▸ ${e.nom}${e.dossier ? ` (dans ${e.dossier})` : ''}`);
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
