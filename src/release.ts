import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, hasTrackedChanges, tagExists } from './git.js';
import { RafError } from './plan.js';
import type { Day } from './dates.js';
import { releaseIssueLines } from './issues.js';
import { commandesFumee, fumerPaquet } from './release-fumee.js';
import { ciAvantEcriture } from './release-ci.js';
import { hasEntries, nothingToRelease, releaseFileLine, removeFragments, versionSection } from './changelog-fragments.js';

const BUMPS = ['patch', 'minor', 'major'] as const;
type Bump = (typeof BUMPS)[number];

const PACKAGE = 'package.json';
const LOCK = 'package-lock.json';
const PLUGIN = '.claude-plugin/plugin.json';
const MARKETPLACE = '.claude-plugin/marketplace.json';
const CHANGELOG = 'CHANGELOG.md';
const WHATS_NEW = 'docs/whats-new.md';
/** Longueur maximale (en caractères) de la ligne d'une version dans la liste courte de docs/whats-new.md. */
const SHORT_LINE_MAX = 240;

type Json = Record<string, any>;

function nextVersion(current: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new RafError(`release : la version de ${PACKAGE} (${current}) n'est pas de la forme x.y.z, elle ne se calcule pas`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function readJson(root: string, file: string): Json {
  try {
    return JSON.parse(readFileSync(join(root, file), 'utf8')) as Json;
  } catch (e) {
    throw new RafError(`release : ${file} illisible (${(e as Error).message})`);
  }
}

/** Remplace la première capture d'un motif `(préfixe)(ancienne)(suffixe)` ; null si le motif est absent. */
function swap(text: string, pattern: RegExp, version: string): string | null {
  return pattern.test(text) ? text.replace(pattern, `$1${version}$3`) : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Écart entre les dépendances de package.json et celles de la racine du lock : ce qu'un `npm install` ferait bouger. */
function lockDrift(pkg: Json, lock: Json): string[] {
  const root: Json = lock.packages?.[''] ?? {};
  const out: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const want: Json = pkg[field] ?? {};
    const have: Json = root[field] ?? {};
    for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
      if (want[name] !== have[name]) out.push(`${field}.${name} : ${PACKAGE} ${want[name] ?? '(absent)'}, ${LOCK} ${have[name] ?? '(absent)'}`);
    }
  }
  return out;
}

/** Les sections d'un CHANGELOG « Keep a Changelog » : le corps de [Unreleased] et le texte à partir de la section suivante. */
export function splitUnreleased(text: string): { before: string; body: string; after: string } {
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!head) throw new RafError(`release : ${CHANGELOG} n'a pas de section « ## [Unreleased] » à renommer`);
  const start = head.index + head[0].length;
  const next = /^## /m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return { before: text.slice(0, head.index), body: text.slice(start, end), after: text.slice(end) };
}

/** Un titre de sous-section répété sous [Unreleased] (à la casse près ; refusé à la release et par la porte, `test/changelog-unreleased-titres-l568.test.ts`) : la trace d'une fusion de lots qui a recopié la section ; publié, il doublerait les entrées. */
export function refuseDuplicateTitles(body: string): void {
  const seen = new Set<string>();
  for (const [, title] of body.matchAll(/^### (.+?)\s*$/gm)) {
    const key = title.toLowerCase();
    if (seen.has(key)) throw new RafError(`release : la section [Unreleased] de ${CHANGELOG} porte « ### ${title} » plus d'une fois — une fusion de lots a recopié le titre ; n'en garder qu'un, avec les entrées une seule fois`);
    seen.add(key);
  }
}

interface Planned {
  version: string;
  /** Le corps de [Unreleased], celui qui devient la section de la version. */
  body: string;
  current: string;
  writes: Map<string, string>;
  /** Les fragments de changelog.d/ assemblés dans la section, que le commit de version retire (L679). */
  removes: string[];
  /** Les fichiers du commit de version : ceux écrits, puis les fragments retirés. */
  files: string[];
  /** Les autres plugins du marketplace dont la version a monté (code changé depuis la dernière release). */
  autres: string[];
  pluginName: string | null;
  marketplaceName: string | null;
  packageName: string;
  isPrivate: boolean;
  hasEvalScript: boolean;
}

/** Un échec de git (hors dépôt, dépôt sans commit) est un refus, pas une trace de pile. */
const inGit = <T>(what: string, f: () => T): T => {
  try {
    return f();
  } catch (e) {
    throw new RafError(`release : ${what} impossible (${((e as Error).message.split('\n').find((l) => /^fatal|^error/i.test(l)) ?? (e as Error).message).trim()}) — la commande se lance dans un dépôt git qui a au moins un commit`);
  }
};

/** Calcule tous les fichiers de la release SANS rien écrire : un refus laisse l'arbre intact. */
/** Patch des autres plugins du marketplace dont le code a changé depuis v<current> sous la même version (D-6) ; écrit leur plugin.json et le marketplace. */
function bumpAutresPlugins(root: string, current: string, pluginName: string | null, writes: Map<string, string>, put: (file: string, text: string) => void): string[] {
  const autres: string[] = [];
  let market = writes.get(MARKETPLACE)!;
  for (const p of (JSON.parse(market) as Json).plugins as Json[]) {
    const b = bumpAutrePlugin(root, current, pluginName, p);
    if (!b) continue;
    market = market.replace(new RegExp(`("name":\\s*"${escape(String(p.name))}"(?:[^{}]|\\{[^{}]*\\})*?"version":\\s*")([^"]*)(")`), `$1${b.neuve}$3`);
    put(b.fichier, b.texte); autres.push(`${p.name} ${b.vIci} → ${b.neuve} (code changé depuis v${current})`);
  }
  writes.set(MARKETPLACE, market);
  return autres;
}

function bumpAutrePlugin(root: string, current: string, pluginName: string | null, p: Json): { fichier: string; texte: string; vIci: string; neuve: string } | null {
  const src = typeof p.source === 'string' ? p.source.replace(/^\.\//, '').replace(/\/$/, '') : '';
  const fichier = `${src}/${PLUGIN}`;
  if (!src || p.name === pluginName || !existsSync(join(root, fichier))) return null;
  const change = spawnSync('git', ['diff', '--quiet', `v${current}`, 'HEAD', '--', src], { cwd: root }).status === 1;
  const avant = spawnSync('git', ['show', `v${current}:${fichier}`], { cwd: root, encoding: 'utf8' });
  const vAvant = avant.status === 0 ? String((JSON.parse(avant.stdout) as Json).version ?? '') : '';
  const vIci = String(readJson(root, fichier).version ?? '');
  if (!change || vIci !== vAvant || !/^\d+\.\d+\.\d+$/.test(vIci)) return null;
  const neuve = nextVersion(vIci, 'patch');
  return { fichier, vIci, neuve, texte: readFileSync(join(root, fichier), 'utf8').replace(/("version":\s*")[^"]*(")/, `$1${neuve}$2`) };
}

/** Chaque fichier écrit doit se relire avec la version attendue : un motif qui aurait touché un autre champ est un refus, pas une release fausse. */
function verifierRelecture(writes: Map<string, string>, version: string): void {
  for (const [file, text] of writes) {
    if (!file.endsWith('.json')) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      throw new RafError(`release : ${file} ne se relirait plus après la mise à jour de la version`);
    }
    if (file !== PLUGIN && file !== PACKAGE && file !== LOCK && file.endsWith(PLUGIN)) continue; // un autre plugin garde sa propre version
    const seen = file === MARKETPLACE ? parsed.plugins.some((p: Json) => p.version === version) : parsed.version === version;
    if (!seen) throw new RafError(`release : ${file} ne porte pas ${version} après la mise à jour`);
  }
}

function plan(root: string, bump: Bump, today: Day): Planned {
  if (!existsSync(join(root, PACKAGE))) throw new RafError(`release : ${PACKAGE} introuvable dans ${root}`);
  const pkg = readJson(root, PACKAGE);
  const current = String(pkg.version ?? '');
  const version = nextVersion(current, bump);
  if (inGit('la lecture de l\'état git', () => hasTrackedChanges(root, [WHATS_NEW]))) throw new RafError(`release : l'arbre de travail a des fichiers suivis modifiés (hors ${WHATS_NEW}, que le commit de version embarque) — le commit de version ne tient que les fichiers de version ; les commiter ou les remiser d'abord`);
  if (inGit('la lecture des tags', () => tagExists(root, `v${version}`))) throw new RafError(`release : la version ${version} est déjà taguée (v${version}) — rien à préparer`);

  const writes = new Map<string, string>();
  const files: string[] = [];
  const put = (file: string, text: string) => {
    writes.set(file, text);
    files.push(file);
  };
  const edit = (file: string, edits: Array<[RegExp | ((text: string) => RegExp), string]>): string => {
    let text = readFileSync(join(root, file), 'utf8');
    for (const [spec, label] of edits) {
      const next = swap(text, typeof spec === 'function' ? spec(text) : spec, version);
      if (next === null) throw new RafError(`release : ${file} n'a pas ${label} à mettre à jour`);
      text = next;
    }
    return text;
  };
  // Le champ de tête du fichier, à l'indentation du fichier (deux espaces, quatre, tabulation) : celle de sa première clé.
  const topVersion = (text: string) => new RegExp(`^(${escape(/^\{[ \t]*\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ')}"version":\\s*")([^"]*)(")`, 'm');

  put(PACKAGE, edit(PACKAGE, [[topVersion, 'de champ "version"']]));

  if (existsSync(join(root, LOCK))) {
    const lock = readJson(root, LOCK);
    if (lock.version !== current || (lock.packages?.['']?.version ?? current) !== current) {
      throw new RafError(`release : ${LOCK} (version ${lock.version}) n'est pas à la version de ${PACKAGE} (${current}) — un \`npm install\` le recale, à commiter à part`);
    }
    const drift = lockDrift(pkg, lock);
    if (drift.length > 0) throw new RafError(`release : ${LOCK} n'est pas à jour des dépendances de ${PACKAGE}, un \`npm install\` les ferait bouger — à commiter à part avant la release :\n  ${drift.join('\n  ')}`);
    const edits: Array<[RegExp | ((text: string) => RegExp), string]> = [[topVersion, 'de champ "version"']];
    if (lock.packages?.['']) edits.push([/("packages":\s*\{\s*"":\s*\{[^{}]*?"version":\s*")([^"]*)(")/, 'de version pour la racine de packages']);
    put(LOCK, edit(LOCK, edits));
  }

  let pluginName: string | null = null;
  let marketplaceName: string | null = null;
  if (existsSync(join(root, PLUGIN))) {
    pluginName = String(readJson(root, PLUGIN).name ?? '');
    put(PLUGIN, edit(PLUGIN, [[topVersion, 'de champ "version"']]));
  }
  if (existsSync(join(root, MARKETPLACE))) {
    const market = readJson(root, MARKETPLACE);
    marketplaceName = typeof market.name === 'string' ? market.name : null;
    // Le plugin du dépôt : celui qui porte le nom de plugin.json, sinon celui qui était à la version du paquet ; les autres plugins du marketplace gardent la leur.
    const entries: Json[] = Array.isArray(market.plugins) ? market.plugins : [];
    const own = entries.find((p) => pluginName !== null && p?.name === pluginName) ?? entries.find((p) => p?.version === current);
    if (!own) throw new RafError(`release : ${MARKETPLACE} n'a pas de plugin ${pluginName ? `« ${pluginName} »` : `à la version ${current}`} à mettre à jour`);
    put(MARKETPLACE, edit(MARKETPLACE, [[new RegExp(`("name":\\s*"${escape(String(own.name))}"(?:[^{}]|\\{[^{}]*\\})*?"version":\\s*")([^"]*)(")`), `de version pour le plugin « ${own.name} »`]]));
  }

  // Les autres plugins du marketplace (le mod cadence-hud) : un code changé depuis la dernière release sous la même version est
  // une version que personne ne voit passer (cadence-hud resté 0.7.0 de la 1.39.0 à la 2.0.2, demande de Sylvain du 10-11) → patch, ici.
  const autres = writes.has(MARKETPLACE) && inGit('la lecture des tags', () => tagExists(root, `v${current}`)) ? bumpAutresPlugins(root, current, pluginName, writes, put) : [];

  if (!existsSync(join(root, CHANGELOG))) throw new RafError(`release : ${CHANGELOG} n'existe pas — la release renomme sa section [Unreleased], il faut donc un ${CHANGELOG} qui en porte une`);
  const changelog = readFileSync(join(root, CHANGELOG), 'utf8');
  const { before, body: own, after } = splitUnreleased(changelog);
  refuseDuplicateTitles(own);
  // L679 : les fragments de changelog.d/ (un par lot) s'assemblent dans la section, à la suite de ce que [Unreleased] porte encore, et sont retirés par le commit de version.
  const { body, removes } = versionSection(root, own);
  if (!hasEntries(body)) throw new RafError(nothingToRelease(root));
  // Une section [Unreleased] vide reste au-dessus : sans elle, la fusion de CHANGELOG du mode worktree d'orchestrate ne trouve plus où poser les entrées des lots suivants.
  put(CHANGELOG, `${before}## [Unreleased]\n\n## [${version}] - ${today}\n${body}${after}`);
  files.push(...removes);

  verifierRelecture(writes, version);

  return {
    version,
    body,
    current,
    writes,
    removes,
    files,
    autres,
    pluginName,
    marketplaceName,
    packageName: String(pkg.name ?? ''),
    isPrivate: pkg.private === true,
    hasEvalScript: typeof pkg.scripts?.['eval:plugin'] === 'string',
  };
}

/**
 * docs/whats-new.md porte la version sous deux formes, écrites à la main ou par une session (jamais par la commande) :
 * une ligne de la liste « In two lines » (≤ 240 caractères, en tête) et un paragraphe long (en tête de « Version by version »).
 * Rend les écarts, une ligne chacun ; vide quand les deux sont là, à leur place.
 */
function whatsNewIssues(text: string, version: string): string[] {
  const lines = text.split('\n');
  const issues: string[] = [];
  // « Version by version » coupe le fichier : la liste courte est avant, les paragraphes longs sont après (sauf l'introduction, premier paragraphe de la section).
  const heading = lines.findIndex((l) => /^##\s+Version by version\s*$/.test(l));
  const split = heading < 0 ? lines.length : heading;
  const intro = heading < 0 ? -1 : lines.findIndex((l, i) => i > heading && l.trim() !== '');
  const check = (form: string, absent: string, misplaced: string, pattern: RegExp, from: number, to: number, where: string, max?: number) => {
    const hits = lines.map((l, i) => ({ l, i, v: i >= from && i < to ? pattern.exec(l)?.[1] : undefined })).filter((x) => x.v !== undefined && x.i !== intro);
    const at = hits.findIndex((h) => h.v === version);
    if (at < 0) {
      issues.push(`${WHATS_NEW} : ${form} ${absent} — l'écrire ${where}`);
      return -1;
    }
    if (at > 0) issues.push(`${WHATS_NEW} : ${form} ${misplaced} (après la version ${hits[at - 1].v} ; la plus récente va en premier) — la déplacer ${where}`);
    if (max !== undefined && hits[at].l.length > max) issues.push(`${WHATS_NEW} : ${form} trop longue (${hits[at].l.length} caractères, ${max} au plus)`);
    return hits[at].i;
  };
  const own = check('ligne de « In two lines »', 'manquante', 'mal placée', /^- \*\*(\d+\.\d+\.\d+)\*\*:/, 0, split, 'en tête de la liste', SHORT_LINE_MAX);
  check('paragraphe long', 'manquant', 'mal placé', /^\*\*(\d+\.\d+\.\d+)\*\*:/, split, lines.length, 'juste après l’introduction de « Version by version »');
  // Le test « deux lignes » du dépôt lit toute la section « In two lines », jusqu'au prochain titre « ## », et toute ligne `- **x.y.z**` (deux-points ou non) :
  // les autres lignes que celle de la version qui sort comptent (1.22.0, 28-10 : un paragraphe long y était tombé, la publication a échoué).
  const start = Math.max(0, lines.findIndex((l) => /^##\s+In two lines\s*$/.test(l)));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const end = next < 0 ? lines.length : next;
  lines.slice(start, end).forEach((l, k) => {
    const i = start + k;
    const bullet = /^- \*\*(\d+\.\d+\.\d+)\*\*/.exec(l);
    if (bullet && i !== own && l.length > SHORT_LINE_MAX) issues.push(`${WHATS_NEW} : « In two lines » : la ligne de la version ${bullet[1]} fait ${l.length} caractères, ${SHORT_LINE_MAX} au plus — la raccourcir (le détail va dans « Version by version »)`);
    const long = /^\*\*(\d+\.\d+\.\d+)\*\*:/.exec(l);
    if (long) issues.push(`${WHATS_NEW} : « In two lines » : le paragraphe long de la version ${long[1]} n’y a pas sa place (ligne ${i + 1}) — le mettre dans « Version by version »`);
  });
  return issues;
}

/** Les étapes que le lead joue, dans l'ordre : la commande n'en fait aucune. */
function steps(p: Planned, files: string[], branch: string): string[] {
  const tag = `v${p.version}`;
  // Rouge à la porte ou à l'éval : le tag provisoire est retiré, la release n'a pas eu lieu. Le passage en clone neuf (L446) n'est plus
  // une étape du lead : la commande l'a joué elle-même, sur le commit de version et son tag, avant d'écrire (L698, src/release-ci.ts).
  const untag = `{ git tag -d ${tag}; false; }`;
  const out = [
    `git add ${files.join(' ')} && git commit -m "release: ${p.version}"`,
    `git tag ${tag}    (tag local provisoire sur le commit de version : les tests qui lisent le dernier tag, comme test/changelog.test.ts, voient la version publiée ; retiré si une des deux étapes suivantes est rouge, jamais poussé avant)`,
    `cadence verify --gate --sha HEAD || ${untag}    (la suite et le build rejoués sur le commit de version, où le CHANGELOG n'a plus de [Unreleased] plein ; rouge = tag retiré, pas d'éval)`,
    ...(p.hasEvalScript ? [`npm run eval:plugin -- --trust-plugin || ${untag}    (facturé ; un cas sous le seuil arrête la release et retire le tag ; si la lecture du rapport le juge faux, reposer le tag de l’étape 2 avant le push)`] : []),
    `git push origin ${branch} ${tag}    (le tag provisoire devient le tag de la release ; il lance le workflow de publication)`,
    'gh run watch    (jusqu\'à la fin du run de publication)',
    ...(p.isPrivate || p.packageName === '' ? [] : [`npm view ${p.packageName} version    (doit répondre ${p.version})`]),
    ...(p.pluginName ? [
      ...(p.marketplaceName ? [`claude plugin marketplace update ${p.marketplaceName}    (sans elle, le plugin installé reste à l'ancienne version)`] : []),
      `claude plugin update ${p.pluginName}${p.marketplaceName ? `@${p.marketplaceName}` : ''}    (le plugin se lit depuis le dépôt poussé)`,
      '/reload-plugins    (dans la session Claude Code ouverte, pour charger la nouvelle version)',
    ] : []),
  ];
  return out.map((s, i) => `  ${i + 1}. ${s}`);
}

/**
 * Refonte du 07-11 : une version 2.x ne se prépare qu'avec un banc vert sur l'empreinte de v2 (cadence2 bench verifier-publication).
 * 10-11 (décision de Sylvain) : le dernier passage seul ne distingue pas deux bras identiques (banc court A contre A rouge à ×2,2) ;
 * à défaut de banc vert, un dossier de publication versionné (`docs/v2/publications/<version>.md`) qui cite l'empreinte exacte
 * et les mesures bras par bras (critères du candidat, cumul sur ≥ 3 comparaisons) vaut décision. Le cumul automatique viendra avec L689.
 */
export function gardeBancV2(version: string, verifier: () => { code: number; sortie: string }, dossier?: (version: string) => string | undefined): void {
  if (Number(version.split('.')[0]) < 2) return;
  const r = verifier();
  if (r.code === 0) return;
  const emp = /empreinte ([0-9a-f]{12})\b/.exec(r.sortie)?.[1];
  const texte = dossier?.(version);
  if (emp && texte !== undefined && new RegExp(`^Empreinte de v2 : ${emp}$`, 'm').test(texte)) return;
  const raison = texte === undefined ? `ni dossier ${PUBLICATIONS}/${version}.md` : `et le dossier ${PUBLICATIONS}/${version}.md ne cite pas l'empreinte ${emp ?? '?'} (ligne « Empreinte de v2 : … »)`;
  throw new RafError(`release : ${version} demande un banc vert sur cette version de v2, ${raison} — ${r.sortie.trim() || 'cadence2 introuvable'}`);
}
const PUBLICATIONS = 'docs/v2/publications';

/** `cadence release patch|minor|major [--dry-run]` : prépare le commit de version, sans rien publier. Rend le code de sortie. */
export function release(rest: string[], dryRun: boolean, root: string, today: Day, out: (l: string) => void): number {
  const bump = rest[0] as Bump | undefined;
  if (rest.length !== 1 || !bump || !BUMPS.includes(bump)) throw new RafError('usage : cadence release patch|minor|major [--dry-run]');
  const p = plan(root, bump, today);
  gardeBancV2(p.version, () => {
    const r = spawnSync('node', [join(root, 'v2', 'bin', 'cadence2.js'), 'bench', 'verifier-publication'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const delai = r.error || r.signal ? `cadence2 n'a pas répondu en 60 s (${r.error?.message ?? r.signal}) — ` : '';
    return { code: r.status ?? 1, sortie: `${delai}${r.stdout ?? ''}${r.stderr ?? ''}` };
  }, (v) => { const f = join(root, PUBLICATIONS, `${v}.md`); return existsSync(f) ? readFileSync(f, 'utf8') : undefined; });
  // L696 : le paquet réel (npm pack de HEAD), installé dans un dossier vide, joue ses commandes de fumée avant tout écrit ; un rouge refuse la release.
  const fumee = commandesFumee(root, readJson(root, PACKAGE));
  if (fumee.length > 0) fumerPaquet(root, fumee, out);

  const whatsNewPath = join(root, WHATS_NEW);
  const hasWhatsNew = existsSync(whatsNewPath);
  // L698 : la CI de publication (le workflow déclenché par un tag) rejouée dans un clone neuf du commit de version, tagué ; un rouge refuse la release.
  ciAvantEcriture(root, dryRun, { version: p.version, writes: p.writes, removes: p.removes, copies: hasWhatsNew ? [WHATS_NEW] : [] }, out);
  const files = hasWhatsNew ? [...p.files, WHATS_NEW] : p.files;
  const branch = inGit('la lecture de la branche', () => currentBranch(root)) ?? 'main';

  out(`${dryRun ? 'release (--dry-run, rien n\'est écrit)' : 'release'} : ${p.current} → ${p.version}`);
  for (const x of p.autres) out(`  ${x}`);
  for (const f of p.files) out(releaseFileLine(f, { version: p.version, today, removes: p.removes, dryRun }));
  if (!dryRun) {
    for (const [file, text] of p.writes) writeFileSync(join(root, file), text);
    removeFragments(root, p.removes);
  }

  let ready = true;
  if (hasWhatsNew) {
    const issues = whatsNewIssues(readFileSync(whatsNewPath, 'utf8'), p.version);
    if (issues.length === 0) out(`  ${WHATS_NEW} : les deux formes de ${p.version} sont là`);
    else {
      ready = false;
      for (const i of issues) out(`  ${i}`);
      out(dryRun
        ? '  le commit de version ne serait pas prêt : écrire ou déplacer ces formes (à la main ou par une session) avant de lancer la commande'
        : '  le commit de version n\'est pas prêt : écrire ces formes (à la main ou par une session), puis suivre les étapes ci-dessous sans relancer la commande (elle changerait encore la version)');
    }
  }

  out('étapes du lead, dans l\'ordre (la commande n\'en joue aucune ; chacune se lit par son code de sortie : jamais de pipe (`| tail`, `| grep`) derrière une commande dont le code de sortie compte, il lui substitue celui du filtre) :');
  for (const s of steps(p, files, branch)) out(s);
  // les lots de la version qui citent une issue GitHub (L548) : le lead ferme, une fois la publication vérifiée ; la commande n'en ferme aucune
  releaseIssueLines(root, p.body, p.version).forEach((l) => out(l));
  return ready ? 0 : 1;
}
