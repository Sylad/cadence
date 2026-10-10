import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';

// Étape accept d'orchestrate (L173, spec etape-spec S5) : le fichier acceptation.json d'un lot et le verrou de ses tests rouges.
//
// acceptation.json (`<spec.dir>/<écran>/acceptation.json`) : { lot, fiche, fichiers[], vert }.
// Le sha du commit rouge n'y figure PAS (une session pourrait le réécrire) : c'est le commit qui a AJOUTÉ le fichier, relu dans git.
// La seule différence tolérée sur ce fichier, par rapport à ce commit, est la clé `vert`, posée par le cycle (`setVert`).

export interface Acceptation {
  lot: string;
  fiche: string;
  fichiers: string[];
  vert: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

const gitOk = (repo: string, ...args: string[]): boolean => {
  try {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Les `acceptation.json` suivis sous `dir` à une révision (HEAD par défaut). */
export function listAcceptations(repo: string, dir: string, rev = 'HEAD'): string[] {
  try {
    return git(repo, 'ls-tree', '-r', '--name-only', '-z', rev, '--', dir).split('\0').filter((f) => f.endsWith('/acceptation.json'));
  } catch {
    return [];
  }
}

/** Forme du fichier lu, ou la raison pour laquelle il n'en a pas. */
export function parseAcceptation(text: string): Acceptation | string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return `JSON illisible (${(e as Error).message})`;
  }
  if (!isObj(doc)) return 'objet attendu';
  const { lot, fiche, fichiers, vert } = doc;
  if (typeof lot !== 'string' || !lot) return 'clé « lot » (id du lot) attendue';
  if (typeof fiche !== 'string' || !fiche) return 'clé « fiche » (chemin de la fiche) attendue';
  if (!Array.isArray(fichiers) || fichiers.length === 0 || fichiers.some((f) => typeof f !== 'string' || !f)) return 'clé « fichiers » : liste non vide de chemins attendue';
  if (typeof vert !== 'boolean') return 'clé « vert » (booléen) attendue';
  return { lot, fiche, fichiers: fichiers as string[], vert };
}

/** Le commit rouge : celui qui a ajouté le fichier (le plus ancien si le fichier a été supprimé puis ajouté de nouveau). Null s'il n'est pas dans l'historique. */
export function redSha(repo: string, path: string): string | null {
  try {
    const shas = git(repo, 'log', '--diff-filter=A', '--format=%H', '--', path).split('\n').filter(Boolean);
    return shas.length ? shas[shas.length - 1] : null;
  } catch {
    return null;
  }
}

/** Chemin (relatif au dépôt) de l'`acceptation.json` du lot sous `dir`, ou null. */
export function findAcceptation(repo: string, dir: string, lot: string): string | null {
  for (const path of listAcceptations(repo, dir).sort()) {
    try {
      const a = parseAcceptation(readFileSync(join(repo, path), 'utf8'));
      if (typeof a !== 'string' && a.lot === lot) return path;
    } catch {
      // illisible : pas celui du lot
    }
  }
  return null;
}

/** Pose `vert: true` dans le fichier (le cycle, jamais une session) ; le commit est à faire. */
export function setVert(repo: string, path: string): void {
  const file = join(repo, path);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Obj;
  doc.vert = true;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Écarts de l'`acceptation.json` écrit par la session accept (vide = accepté). */
export function checkAcceptation(repo: string, path: string, lot: string, fiche: string): string[] {
  const file = join(repo, path);
  if (!existsSync(file)) return [`${path} : acceptation.json absent (le lister dans ${path}, avec les fichiers de tests, dans le commit rouge)`];
  const a = parseAcceptation(readFileSync(file, 'utf8'));
  if (typeof a === 'string') return [`${path} : ${a}`];
  const problems: string[] = [];
  if (a.lot !== lot) problems.push(`${path} : lot « ${a.lot} » au lieu de ${lot}`);
  if (a.fiche !== fiche) problems.push(`${path} : fiche « ${a.fiche} » au lieu de ${fiche}`);
  if (a.vert) problems.push(`${path} : vert: true à l'écriture (les tests sont rouges : vert: false ; seul le cycle pose vert: true)`);
  const sha = redSha(repo, path);
  if (!sha) problems.push(`${path} : non commité`);
  let texts = '';
  for (const f of a.fichiers) {
    const norm = posix.normalize(f);
    if (isAbsolute(norm) || norm.startsWith('../') || norm === '..') {
      problems.push(`${f} : fichier hors du dépôt`);
      continue;
    }
    if (!existsSync(join(repo, norm))) {
      problems.push(`${f} : fichier de test listé mais absent`);
      continue;
    }
    if (sha && !gitOk(repo, 'cat-file', '-e', `${sha}:${norm}`)) problems.push(`${f} : absent du commit rouge de ${path} (fichiers de tests et acceptation.json vont dans le même commit)`);
    texts += `${readFileSync(join(repo, norm), 'utf8')}\n`;
  }
  try {
    const doc = parse(readFileSync(join(repo, fiche), 'utf8')) as { regles?: { id?: unknown; tests?: unknown }[] };
    for (const r of doc.regles ?? []) for (const t of Array.isArray(r.tests) ? r.tests : []) if (typeof t === 'string' && !texts.includes(t) && !texts.includes(t.replace(/'/g, "\\'"))) problems.push(`${r.id} : test « ${t} » (nom prévu dans la fiche) absent des fichiers listés`);
  } catch {
    problems.push(`${fiche} : fiche illisible`);
  }
  return problems;
}

/** JSON à clés triées, sans la clé `vert` : la forme que le verrou compare. */
const canon = (a: Obj): string => JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'vert').sort(([x], [y]) => x.localeCompare(y))));

const show = (repo: string, rev: string, path: string): Obj | null => {
  try {
    const v = JSON.parse(git(repo, 'show', `${rev}:${path}`)) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * Le verrou (spec etape-spec § 5), valable pour toute session du dépôt : les tests d'acceptation de TOUS les lots sont inchangés depuis leur
 * commit rouge, au sens de git (arbre de travail compris), et chaque `acceptation.json` n'a bougé que par sa clé `vert` — posée par le
 * cycle, donc jamais modifiée pendant une session (comparée à `headBefore`). Vide = rien à signaler.
 * `created: 'allow'` : l'étape accept crée le fichier de son lot ; ailleurs, un fichier neuf est un écart.
 */
export function lockViolations(repo: string, dir: string, headBefore: string, opts: { created?: 'allow' | 'refuse' } = {}): string[] {
  const out: string[] = [];
  const before = new Set(listAcceptations(repo, dir, headBefore));
  const now = new Set(listAcceptations(repo, dir));
  for (const p of before) if (!now.has(p)) out.push(`${p} : acceptation.json supprimé (verrou des tests d'acceptation)`);
  for (const p of [...now].sort()) {
    const isNew = !before.has(p);
    if (isNew && opts.created !== 'allow') out.push(`${p} : acceptation.json créé hors de l'étape accept`);
    const red = redSha(repo, p);
    const cur = show(repo, 'HEAD', p);
    const base = red ? show(repo, red, p) : null;
    if (!red || !cur || !base) {
      out.push(`${p} : acceptation.json sans commit rouge lisible`);
      continue;
    }
    if (canon(cur) !== canon(base)) out.push(`${p} : acceptation.json modifié depuis le commit rouge ${red.slice(0, 7)} (seule la clé vert, posée par le cycle, peut changer)`);
    const was = isNew ? undefined : show(repo, headBefore, p);
    if (was && was.vert !== cur.vert) out.push(`${p} : clé vert changée pendant la session (elle est posée par le cycle)`);
    const fichiers = Array.isArray(base.fichiers) ? base.fichiers.filter((f): f is string => typeof f === 'string') : [];
    if (!fichiers.length) continue;
    let changed: string[] = [];
    try {
      changed = git(repo, 'diff', '--name-only', '-z', red, '--', ...fichiers).split('\0').filter(Boolean);
    } catch {
      changed = fichiers;
    }
    const lot = typeof base.lot === 'string' ? base.lot : '?';
    for (const f of changed) out.push(`${f} : test d'acceptation de ${lot} modifié depuis le commit rouge ${red.slice(0, 7)} (verrou ${p})`);
  }
  return out;
}
