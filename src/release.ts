import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, hasTrackedChanges, tagExists } from './git.js';
import { RafError } from './plan.js';
import type { Day } from './dates.js';

export const BUMPS = ['patch', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];

const PACKAGE = 'package.json';
const LOCK = 'package-lock.json';
const PLUGIN = '.claude-plugin/plugin.json';
const MARKETPLACE = '.claude-plugin/marketplace.json';
const CHANGELOG = 'CHANGELOG.md';
const WHATS_NEW = 'docs/whats-new.md';
/** Longueur maximale (en caractères) de la ligne d'une version dans la liste courte de docs/whats-new.md. */
export const SHORT_LINE_MAX = 240;

type Json = Record<string, any>;

export function nextVersion(current: string, bump: Bump): string {
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
function splitUnreleased(text: string): { before: string; body: string; after: string } {
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!head) throw new RafError(`release : ${CHANGELOG} n'a pas de section « ## [Unreleased] » à renommer`);
  const start = head.index + head[0].length;
  const next = /^## /m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return { before: text.slice(0, head.index), body: text.slice(start, end), after: text.slice(end) };
}

/** Une section est vide quand elle n'a que des titres de sous-section (« ### Added ») et des lignes blanches. */
function hasEntries(body: string): boolean {
  return body.split('\n').some((l) => l.trim() !== '' && !/^#{3,}\s/.test(l));
}

interface Planned {
  version: string;
  current: string;
  writes: Map<string, string>;
  files: string[];
  pluginName: string | null;
  marketplaceName: string | null;
  packageName: string;
  isPrivate: boolean;
  hasEvalScript: boolean;
}

/** Calcule tous les fichiers de la release SANS rien écrire : un refus laisse l'arbre intact. */
function plan(root: string, bump: Bump, today: Day): Planned {
  if (!existsSync(join(root, PACKAGE))) throw new RafError(`release : ${PACKAGE} introuvable dans ${root}`);
  const pkg = readJson(root, PACKAGE);
  const current = String(pkg.version ?? '');
  const version = nextVersion(current, bump);
  if (hasTrackedChanges(root, [WHATS_NEW])) throw new RafError(`release : l'arbre de travail a des fichiers suivis modifiés (hors ${WHATS_NEW}, que le commit de version embarque) — le commit de version ne tient que les fichiers de version ; les commiter ou les remiser d'abord`);
  if (tagExists(root, `v${version}`)) throw new RafError(`release : la version ${version} est déjà taguée (v${version}) — rien à préparer`);

  const writes = new Map<string, string>();
  const files: string[] = [];
  const put = (file: string, text: string) => {
    writes.set(file, text);
    files.push(file);
  };
  const edit = (file: string, edits: Array<[RegExp, string]>): string => {
    let text = readFileSync(join(root, file), 'utf8');
    for (const [pattern, label] of edits) {
      const next = swap(text, pattern, version);
      if (next === null) throw new RafError(`release : ${file} n'a pas ${label} à mettre à jour`);
      text = next;
    }
    return text;
  };
  const topVersion = /^(  "version":\s*")([^"]*)(")/m;

  put(PACKAGE, edit(PACKAGE, [[topVersion, 'de champ "version"']]));

  if (existsSync(join(root, LOCK))) {
    const lock = readJson(root, LOCK);
    if (lock.version !== current || (lock.packages?.['']?.version ?? current) !== current) {
      throw new RafError(`release : ${LOCK} (version ${lock.version}) n'est pas à la version de ${PACKAGE} (${current}) — un \`npm install\` le recale, à commiter à part`);
    }
    const drift = lockDrift(pkg, lock);
    if (drift.length > 0) throw new RafError(`release : ${LOCK} n'est pas à jour des dépendances de ${PACKAGE}, un \`npm install\` les ferait bouger — à commiter à part avant la release :\n  ${drift.join('\n  ')}`);
    const edits: Array<[RegExp, string]> = [[topVersion, 'de champ "version"']];
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
    put(MARKETPLACE, edit(MARKETPLACE, [[new RegExp(`("name":\\s*"${escape(String(own.name))}"[^{}]*?"version":\\s*")([^"]*)(")`), `de version pour le plugin « ${own.name} »`]]));
  }

  const changelog = readFileSync(join(root, CHANGELOG), 'utf8');
  const { before, body, after } = splitUnreleased(changelog);
  if (!hasEntries(body)) throw new RafError(`release : la section [Unreleased] est vide dans ${CHANGELOG} — rien à publier ; y écrire ce qui change pour l'utilisateur (lots cités)`);
  // Une section [Unreleased] vide reste au-dessus : sans elle, la fusion de CHANGELOG du mode worktree d'orchestrate ne trouve plus où poser les entrées des lots suivants.
  put(CHANGELOG, `${before}## [Unreleased]\n\n## [${version}] - ${today}\n${body}${after}`);

  // Chaque fichier écrit doit se relire avec la version attendue : un motif qui aurait touché un autre champ est un refus, pas une release fausse.
  for (const [file, text] of writes) {
    if (!file.endsWith('.json')) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      throw new RafError(`release : ${file} ne se relirait plus après la mise à jour de la version`);
    }
    const seen = file === MARKETPLACE ? parsed.plugins.some((p: Json) => p.version === version) : parsed.version === version;
    if (!seen) throw new RafError(`release : ${file} ne porte pas ${version} après la mise à jour`);
  }

  return {
    version,
    current,
    writes,
    files,
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
export function whatsNewIssues(text: string, version: string): string[] {
  const lines = text.split('\n');
  const issues: string[] = [];
  const check = (form: string, absent: string, misplaced: string, pattern: RegExp, where: string, max?: number) => {
    const hits = lines.map((l) => ({ l, v: pattern.exec(l)?.[1] })).filter((x) => x.v !== undefined);
    const at = hits.findIndex((h) => h.v === version);
    if (at < 0) {
      issues.push(`${WHATS_NEW} : ${form} ${absent} — l'écrire ${where}`);
      return;
    }
    if (at > 0) issues.push(`${WHATS_NEW} : ${form} ${misplaced} (après la version ${hits[at - 1].v} ; la plus récente va en premier) — la déplacer ${where}`);
    if (max !== undefined && hits[at].l.length > max) issues.push(`${WHATS_NEW} : ${form} trop longue (${hits[at].l.length} caractères, ${max} au plus)`);
  };
  check('ligne de « In two lines »', 'manquante', 'mal placée', /^- \*\*(\d+\.\d+\.\d+)\*\*:/, 'en tête de la liste', SHORT_LINE_MAX);
  check('paragraphe long', 'manquant', 'mal placé', /^\*\*(\d+\.\d+\.\d+)\*\*:/, 'juste après l’introduction de « Version by version »');
  return issues;
}

/** Les étapes que le lead joue, dans l'ordre : la commande n'en fait aucune. */
function steps(p: Planned, files: string[], branch: string): string[] {
  const tag = `v${p.version}`;
  const out = [
    `git add ${files.join(' ')} && git commit -m "release: ${p.version}"`,
    ...(p.hasEvalScript ? ['npm run eval:plugin -- --trust-plugin    (facturé ; un cas sous le seuil arrête la release)'] : []),
    `git tag ${tag}`,
    `git push origin ${branch} ${tag}    (le tag lance le workflow de publication)`,
    'gh run watch    (jusqu\'à la fin du run de publication)',
    ...(p.isPrivate || p.packageName === '' ? [] : [`npm view ${p.packageName} version    (doit répondre ${p.version})`]),
    ...(p.pluginName ? [`claude plugin update ${p.pluginName}${p.marketplaceName ? `@${p.marketplaceName}` : ''}    (le plugin se lit depuis le dépôt poussé)`] : []),
  ];
  return out.map((s, i) => `  ${i + 1}. ${s}`);
}

/** `cadence release patch|minor|major [--dry-run]` : prépare le commit de version, sans rien publier. Rend le code de sortie. */
export function release(rest: string[], dryRun: boolean, root: string, today: Day, out: (l: string) => void): number {
  const bump = rest[0] as Bump | undefined;
  if (rest.length !== 1 || !bump || !BUMPS.includes(bump)) throw new RafError('usage : cadence release patch|minor|major [--dry-run]');
  const p = plan(root, bump, today);

  const whatsNewPath = join(root, WHATS_NEW);
  const hasWhatsNew = existsSync(whatsNewPath);
  const files = hasWhatsNew ? [...p.files, WHATS_NEW] : p.files;
  const branch = currentBranch(root) ?? 'main';

  out(`${dryRun ? 'release (--dry-run, rien n\'est écrit)' : 'release'} : ${p.current} → ${p.version}`);
  for (const f of p.files) out(`  ${dryRun ? 'écrirait' : 'écrit'} : ${f}${f === 'CHANGELOG.md' ? ` ([Unreleased] → [${p.version}] - ${today}, une section [Unreleased] vide au-dessus)` : ' (version)'}`);
  if (!dryRun) for (const [file, text] of p.writes) writeFileSync(join(root, file), text);

  let ready = true;
  if (hasWhatsNew) {
    if (dryRun) {
      out(`  ${WHATS_NEW} : à écrire à la main ou par une session — la ligne de « In two lines » (≤ ${SHORT_LINE_MAX} caractères) en tête de la liste, le paragraphe long juste après l’introduction de « Version by version » ; la commande ne les écrit pas et les vérifiera`);
    } else {
      const issues = whatsNewIssues(readFileSync(whatsNewPath, 'utf8'), p.version);
      if (issues.length === 0) out(`  ${WHATS_NEW} : les deux formes de ${p.version} sont là`);
      else {
        ready = false;
        for (const i of issues) out(`  ${i}`);
        out('  le commit de version n\'est pas prêt : écrire ces formes (à la main ou par une session), puis suivre les étapes ci-dessous sans relancer la commande (elle changerait encore la version)');
      }
    }
  }

  out('étapes du lead, dans l\'ordre (la commande n\'en joue aucune) :');
  for (const s of steps(p, files, branch)) out(s);
  return ready ? 0 : 1;
}
