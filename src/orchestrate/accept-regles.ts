import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { citedRefs } from '../link.js';
import type { Ref } from '../plan.js';
import { listAcceptations, parseAcceptation, sansEmpreinte, type Acceptation } from './accept.js';

// Les règles dont un lot doit les tests sur une fiche partagée par plusieurs lots (L552, fiche accept-regles-du-lot, issue #25).

/** Ce que `checkAcceptation` a besoin de savoir pour juger une fiche partagée : `dir` = `config.spec.dir`, `refsOf` = `plan.refs`. Sans lui, la fiche est tenue pour non partagée. */
export interface Partage {
  dir: string;
  refsOf: (text: string) => Ref[];
}

type Regle = { id?: unknown; tests?: unknown };

/** Le lot jugé : son acceptation (`path`, lue en `a`), sa fiche, le texte de ses fichiers de tests et, s'il est donné, ce qui permet de voir la fiche partagée. */
export interface Jugement {
  repo: string;
  path: string;
  a: Acceptation;
  lot: string;
  fiche: string;
  texts: string;
  partage?: Partage;
}

const git = (repo: string, ...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

const gitOk = (repo: string, ...args: string[]): boolean => {
  try {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const hasName = (texts: string, name: string): boolean => texts.includes(name) || texts.includes(name.replace(/'/g, "\\'"));

/** Le texte, au HEAD, des fichiers de tests d'une acceptation (R7) ; un fichier absent du HEAD n'en fournit pas les noms (R12). */
function textesAuHead(repo: string, a: Acceptation): string {
  let out = '';
  for (const f of a.fichiers) {
    try {
      out += `${git(repo, 'show', `HEAD:${posix.normalize(f)}`)}\n`;
    } catch {
      // fichier absent du HEAD
    }
  }
  return out;
}

/** L'acceptation lue au HEAD, ou null si elle y est illisible (R12). */
function auHead(repo: string, path: string): Acceptation | null {
  try {
    const a = parseAcceptation(git(repo, 'show', `HEAD:${path}`));
    return typeof a === 'string' ? null : a;
  } catch {
    return null;
  }
}

/**
 * Les autres acceptations lisibles au HEAD de `dir` qui visent la même fiche (R8) : null si aucune (fiche non partagée) ; sinon le texte des fichiers de tests
 * de celles qui sont scellées (R7 : une empreinte par fichier listé, le contenu n'est pas comparé).
 */
function voisines(j: Pick<Jugement, 'repo' | 'path' | 'lot' | 'fiche'>, dir: string): { scellees: string } | null {
  const autres = listAcceptations(j.repo, dir)
    .filter((p) => p !== j.path)
    .map((p) => auHead(j.repo, p))
    .filter((o): o is Acceptation => o !== null && o.lot !== j.lot && posix.normalize(o.fiche) === posix.normalize(j.fiche));
  return autres.length ? { scellees: autres.filter((o) => sansEmpreinte(o).length === 0).map((o) => textesAuHead(j.repo, o)).join('') } : null;
}

/** Les règles d'une fiche à une révision, par id ; vide quand la fiche n'y existe pas. Lève si elle y est illisible. */
function reglesA(repo: string, rev: string, fiche: string): Map<string, unknown> {
  if (!gitOk(repo, 'cat-file', '-e', `${rev}:${fiche}`)) return new Map();
  const doc = parse(git(repo, 'show', `${rev}:${fiche}`)) as { regles?: Regle[] } | null;
  return new Map((doc?.regles ?? []).flatMap((r): [string, unknown][] => (typeof r?.id === 'string' ? [[r.id, r]] : [])));
}

/** Les commits de sujet `spec` ou `docs` qui citent le lot (`citedRefs`) et ont touché la fiche (R2) ; les `test(<lot>)` et autres types ne comptent pas. */
function commitsDuLot(j: Pick<Jugement, 'repo' | 'lot' | 'fiche'>, refsOf: Partage['refsOf']): string[] {
  const out: string[] = [];
  for (const entree of git(j.repo, 'log', '--format=%H%x1f%s%x1f%b%x1e', '--', j.fiche).split('\x1e')) {
    const [sha, subject = '', body = ''] = entree.trim().split('\x1f');
    if (sha && /^(spec|docs)(\([^)]*\))?!?\s*:/.test(subject) && citedRefs({ sha, day: '', subject, body }, refsOf).some((r) => r.lot === j.lot)) out.push(sha);
  }
  return out;
}

/**
 * Les règles du lot sur une fiche partagée, sans liste déclarée (R3) : celles qu'ajoutent ou modifient (objet YAML différent, mise en forme indifférente) ses commits.
 * Null (toutes les règles) quand aucun commit du lot ne touche une règle, ou que l'historique est illisible (R5, R6).
 */
function reglesDuLot(j: Pick<Jugement, 'repo' | 'lot' | 'fiche'>, refsOf: Partage['refsOf']): Set<string> | null {
  const touchees = new Set<string>();
  try {
    for (const sha of commitsDuLot(j, refsOf)) {
      const avant = reglesA(j.repo, `${sha}^`, j.fiche);
      for (const [id, r] of reglesA(j.repo, sha, j.fiche)) if (!isDeepStrictEqual(avant.get(id), r)) touchees.add(id);
    }
  } catch {
    return null;
  }
  return touchees.size ? touchees : null;
}

/** La clé « regles » (R4) : le message de l'écart quand elle n'est pas une liste non vide d'ids de règles de la fiche, sinon les ids. */
function listeDeclaree(j: Jugement, ids: Set<string>): { ids: Set<string> } | { ecarts: string[] } {
  const l = j.a.regles;
  if (!Array.isArray(l) || l.length === 0 || l.some((i) => typeof i !== 'string' || !i)) return { ecarts: [`${j.path} : clé « regles » : liste non vide d'ids de règles de la fiche attendue`] };
  const inconnues = [...new Set((l as string[]).filter((i) => !ids.has(i)))];
  return inconnues.length ? { ecarts: inconnues.map((i) => `${j.path} : clé « regles » : règle « ${i} » absente de la fiche`) } : { ids: new Set(l as string[]) };
}

/** Les règles dont les tests sont exigés : null = toutes (R10, R5, R6) ; ou les écarts de la clé « regles » (R4). */
function exigees(j: Jugement, regles: Regle[], partagee: boolean): { exiges: Set<string> | null } | { ecarts: string[] } {
  if (j.a.regles !== undefined) {
    const l = listeDeclaree(j, new Set(regles.flatMap((r) => (typeof r.id === 'string' ? [r.id] : []))));
    return 'ecarts' in l ? l : { exiges: l.ids };
  }
  return { exiges: partagee && j.partage ? reglesDuLot(j, j.partage.refsOf) : null };
}

/**
 * Écarts de tests absents : les règles exigées sont celles de la clé « regles » (R4), sinon, sur fiche partagée, celles du lot (R1-R3, R5, R6), sinon toutes (R10) ;
 * un nom déjà présent dans une acceptation scellée voisine est accepté (R7).
 */
export function testsAbsents(j: Jugement, regles: Regle[]): string[] {
  const autres = j.partage ? voisines(j, j.partage.dir) : null;
  const sel = exigees(j, regles, autres !== null);
  if ('ecarts' in sel) return sel.ecarts;
  const manque = (t: unknown): t is string => typeof t === 'string' && !hasName(j.texts, t) && !hasName(autres?.scellees ?? '', t);
  return regles
    .filter((r) => !sel.exiges || sel.exiges.has(String(r.id)))
    .flatMap((r) => (Array.isArray(r.tests) ? r.tests : []).filter(manque).map((t) => `${r.id} : test « ${t} » (nom prévu dans la fiche) absent des fichiers listés`));
}

/** L'acceptation du lot lue dans l'arbre de travail, ou null si elle est absente ou illisible. */
function lue(repo: string, path: string): Acceptation | null {
  try {
    const a = parseAcceptation(readFileSync(join(repo, path), 'utf8'));
    return typeof a === 'string' ? null : a;
  } catch {
    return null;
  }
}

/**
 * Les règles du lot pour les briefs en aval (L559, issue #27) : la clé « regles » de son acceptation si elle est une liste non vide d'ids, sinon, sur une fiche
 * que d'autres lots visent aussi, celles que ses commits `spec`/`docs` touchent ; null (toutes les règles) sinon, comme `testsAbsents`. Jamais d'écart : un brief
 * garde toutes les règles plutôt que d'en perdre.
 */
export function reglesDuLotPourBrief(o: { repo: string; lot: string; fiche: string; acceptation?: string; partage: Partage }): Set<string> | null {
  const j = { repo: o.repo, path: o.acceptation ?? '', lot: o.lot, fiche: o.fiche };
  const a = o.acceptation ? lue(o.repo, o.acceptation) : null;
  if (Array.isArray(a?.regles) && a.regles.length > 0 && a.regles.every((i) => typeof i === 'string' && i)) return new Set(a.regles as string[]);
  return voisines(j, o.partage.dir) ? reglesDuLot(j, o.partage.refsOf) : null;
}
