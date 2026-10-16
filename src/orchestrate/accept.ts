import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';
import type { Ref } from '../plan.js';
import { citedRefs } from '../link.js';

// Étape accept d'orchestrate (L173, spec etape-spec S5) : le fichier acceptation.json d'un lot et le verrou de ses tests rouges.
//
// acceptation.json (`<spec.dir>/<écran>/acceptation-<lot>.json`, un fichier par lot : deux lots sur un même écran ne se partagent pas le verrou) : { lot, fiche, fichiers[], vert, empreintes? }.
// La session accept écrit lot, fiche, fichiers et `vert: false` ; une fois ses contrôles passés, le PROGRAMME scelle le fichier (`sealAcceptation` :
// empreinte git de chaque fichier de tests) et le commite : ce commit est le commit rouge.
// Le sha du commit rouge n'est écrit nulle part dans le fichier (une session pourrait le réécrire) : c'est le dernier commit de l'historique git
// qui a changé le fichier autrement que par sa clé `vert` (`redSha`).
// La seule différence tolérée sur ce fichier, par rapport à ce commit, est la clé `vert`, posée par le cycle (`setVert`).

export interface Acceptation {
  lot: string;
  fiche: string;
  fichiers: string[];
  vert: boolean;
  /** Acceptation de bout en bout (navigateur, build requis, L203) : même à `vert: true` elle reste hors du lanceur ordinaire et de la CI unitaire ; la suite e2e la lance après le build. */
  e2e?: boolean;
  /** Empreinte git (blob) de chaque fichier de tests, posée par le programme au scellé. */
  empreintes?: Record<string, string>;
  /** Journal des rescellés d'un seul test (`cadence spec reseal`, L200) : le test, la raison donnée par le lead, la date et les deux empreintes. */
  resceaux?: { test: string; raison: string; date: string; avant: string; apres: string; porteur?: string; ficheAmendee?: string }[];
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

/** Un fichier d'acceptation : `acceptation-<lot>.json` (ou l'ancien `acceptation.json`, lu tel quel). */
export const isAcceptationFile = (path: string): boolean => /(^|\/)acceptation(-[^/]+)?\.json$/.test(path);

/** Chemin attendu de l'acceptation d'un lot, à côté de la fiche de son écran : un fichier par lot (l'id de lot, `/` et autres réduits à `-`). */
export const acceptationFile = (fiche: string, lot: string): string => posix.join(posix.dirname(fiche), `acceptation-${lot.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);

/** Les `acceptation.json` suivis sous `dir` à une révision (HEAD par défaut). */
export function listAcceptations(repo: string, dir: string, rev = 'HEAD'): string[] {
  try {
    return git(repo, 'ls-tree', '-r', '--name-only', '-z', rev, '--', dir).split('\0').filter(isAcceptationFile);
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
  const empreintes = isObj(doc.empreintes) ? (Object.fromEntries(Object.entries(doc.empreintes).filter(([, v]) => typeof v === 'string')) as Record<string, string>) : undefined;
  const resceaux = Array.isArray(doc.resceaux) ? (doc.resceaux.filter((r) => isObj(r) && ['test', 'raison', 'date', 'avant', 'apres'].every((k) => typeof r[k] === 'string')) as NonNullable<Acceptation['resceaux']>) : undefined;
  return { lot, fiche, fichiers: fichiers as string[], vert, ...(doc.e2e === true ? { e2e: true } : {}), ...(empreintes ? { empreintes } : {}), ...(resceaux?.length ? { resceaux } : {}) };
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

/** Le commit rouge : le plus récent qui a changé le fichier autrement que par sa clé `vert` (l'ajout, ou le scellé du programme). Null hors historique. */
export function redSha(repo: string, path: string): string | null {
  let shas: string[];
  try {
    shas = git(repo, 'log', '--format=%H', '--', path).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  for (const sha of shas) {
    const cur = show(repo, sha, path);
    if (!cur) continue; // suppression
    const prev = show(repo, `${sha}^`, path);
    if (!prev || canon(cur) !== canon(prev)) return sha;
  }
  return null;
}

/**
 * Le commit rouge a bougé depuis `anchor` par un rescellé du lead (`cadence spec reseal`, L200) : le nouveau sha, sinon null.
 * Seul un commit qui a allongé le journal `resceaux` ET qu'aucune session de la vague n'a fait (`bySession`) est adopté ; toute autre réécriture reste un écart pour le verrou.
 */
export function resealedRouge(repo: string, path: string, anchor: string, bySession: (sha: string) => boolean = () => false): string | null {
  const now = redSha(repo, path);
  if (!now || now === anchor) return null;
  if (bySession(now)) return null; // un commit de session n'est jamais un rescellé du lead : il reste un écart pour le verrou
  const journal = (rev: string): number => {
    const r = show(repo, rev, path)?.resceaux;
    return Array.isArray(r) ? r.length : 0;
  };
  return journal(now) > journal(anchor) ? now : null;
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

/** Scelle le fichier (le programme, jamais une session) : l'empreinte git de chaque fichier de tests listé ; le commit est à faire. */
export function sealAcceptation(repo: string, path: string): void {
  const file = join(repo, path);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Obj;
  const fichiers = (doc.fichiers as string[]).map((f) => posix.normalize(f));
  doc.empreintes = Object.fromEntries(fichiers.map((f) => [f, git(repo, 'hash-object', '--', f).trim()]));
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * Rescelle UN test (L200, `cadence spec reseal`, le lead — jamais une session) : le test d'un lot en cours contredit sa fiche et le verrou total
 * ne laisse aucun chemin de correction. Seule l'empreinte du test nommé est refaite (les autres fichiers listés restent inchangés), la raison et les deux
 * empreintes vont dans `resceaux`. Le commit (test + acceptation) est à faire : il devient le commit rouge.
 * La fiche est celle du commit rouge, ou (L217) une fiche amendée par des commits qui citent tous le lot (`refsOf` : `plan.refs`, lu comme `citedRefs` ;
 * lot livré : le lot ou son `porteur`) et commitée : l'entrée porte alors `ficheAmendee`, le sha court du dernier commit qui l'a touchée.
 */
export function resealAcceptation(repo: string, path: string, test: string, reason: string, today: string, porteur?: string, refsOf: (text: string) => Ref[] = () => []): { avant: string; apres: string; lot: string; ficheAmendee?: string } {
  const file = join(repo, path);
  const a = parseAcceptation(readFileSync(file, 'utf8'));
  if (typeof a === 'string') throw new Error(`${path} : ${a}`);
  if (!reason.trim()) throw new Error('--reason est obligatoire : la raison du rescellé va dans acceptation.json et en note du lot');
  if (porteur && !a.vert) throw new Error(`${path} n'est pas verte : un lot porteur (${porteur}) ne vaut que pour le test scellé d'un lot livré (vert: true)`);
  const norm = posix.normalize(test);
  const fichiers = a.fichiers.map((f) => posix.normalize(f));
  if (!fichiers.includes(norm)) throw new Error(`${test} n'est pas listé dans ${path} (fichiers : ${fichiers.join(', ')})`);
  const avant = a.empreintes?.[norm];
  if (!a.empreintes || !avant) throw new Error(`${path} n'est pas scellée (pas d'empreinte pour ${norm}) : l'étape accept n'est pas finie, rien à resceller`);
  const red = redSha(repo, path);
  if (!red) throw new Error(`${path} : pas de commit rouge lisible`);
  if (!existsSync(join(repo, norm))) throw new Error(`${norm} : fichier absent (un test supprimé ne se rescelle pas)`);
  // Une fiche modifiée dans l'arbre de travail ou l'index n'est pas celle d'un commit du lot : elle se commite d'abord.
  if (git(repo, 'status', '--porcelain', '--', a.fiche).trim() !== '') throw new Error(`la fiche ${a.fiche} a des modifications non commitées : la commiter (en citant ${a.lot}) avant le rescellé`);
  let ficheAmendee: string | undefined;
  if (!gitOk(repo, 'diff', '--quiet', red, '--', a.fiche)) {
    if (!existsSync(join(repo, a.fiche))) throw new Error(`la fiche ${a.fiche} a été supprimée ou renommée depuis le commit rouge ${red.slice(0, 7)} : le rescellé ne vaut que pour une fiche présente`);
    const citant = new Set([a.lot, ...(porteur ? [porteur] : [])]);
    const commits = git(repo, 'log', '--format=%H%x1f%s%x1f%b%x1e', `${red}..HEAD`, '--', a.fiche).split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => { const [sha = '', subject = '', body = ''] = r.split('\x1f'); return { sha, day: '', subject, body: body.trim() }; });
    const fautif = commits.find((c) => !citedRefs(c, refsOf).some((r) => citant.has(r.lot)));
    if (fautif) throw new Error(`la fiche ${a.fiche} a été modifiée depuis le commit rouge ${red.slice(0, 7)} par un commit qui ne cite pas ${a.lot} : ${fautif.sha.slice(0, 7)}`);
    ficheAmendee = commits[0]?.sha.slice(0, 7);
  }
  const touches = fichiers.filter((f) => f !== norm && (!gitOk(repo, 'diff', '--quiet', red, '--', f) || !existsSync(join(repo, f)) || a.empreintes?.[f] !== git(repo, 'hash-object', '--', f).trim()));
  if (touches.length) throw new Error(`autre(s) test(s) listé(s) modifié(s) depuis le commit rouge : ${touches.join(', ')} (le rescellé ne couvre que ${norm}, le verrou garde le reste)`);
  const apres = git(repo, 'hash-object', '--', norm).trim();
  if (apres === avant) throw new Error(`${norm} est inchangé depuis le scellé : rien à resceller`);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Obj;
  (doc.empreintes as Record<string, string>)[norm] = apres;
  const journal = Array.isArray(doc.resceaux) ? doc.resceaux : [];
  doc.resceaux = [...journal, { test: norm, raison: reason.trim(), date: today, avant, apres, ...(porteur ? { porteur } : {}), ...(ficheAmendee ? { ficheAmendee } : {}) }];
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { avant, apres, lot: a.lot, ...(ficheAmendee ? { ficheAmendee } : {}) };
}

/** Pose `vert: true` dans le fichier (le cycle, jamais une session) ; le commit est à faire. */
export function setVert(repo: string, path: string): void {
  const file = join(repo, path);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Obj;
  doc.vert = true;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Écarts de l'`acceptation.json` écrit par la session accept (vide = accepté). `base` : la tête d'avant la première session accept ; un fichier de tests qui y existe déjà ne peut pas être listé. */
export function checkAcceptation(repo: string, path: string, lot: string, fiche: string, base?: string): string[] {
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
  // Reprise d'une acceptation déjà présente à la base (non scellée) : ses fichiers viennent d'une session accept précédente, pas d'un test ordinaire.
  const fresh = base && !gitOk(repo, 'cat-file', '-e', `${base}:${path}`) ? base : null;
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
    if (fresh && gitOk(repo, 'cat-file', '-e', `${base}:${norm}`)) {
      problems.push(`${f} : ce fichier de tests existait avant la session accept (donnez à vos tests des fichiers neufs : ses tests ordinaires sortiraient de config.test et de la CI tant que le lot n'est pas vert)`);
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

/**
 * La tête d'avant le premier commit de travail du lot (L184) : le parent du plus ancien des commits `work` (ordre indifférent, ceux que repère `plan.refs`).
 * Aucun commit, un commit racine ou illisible : `undefined`.
 */
export function lotStartHead(repo: string, work: string[]): string | undefined {
  let oldest: { sha: string; depth: number } | undefined;
  for (const sha of work) {
    if (!gitOk(repo, 'cat-file', '-e', `${sha}^{commit}`)) continue;
    const depth = Number(git(repo, 'rev-list', '--count', sha).trim());
    if (!oldest || depth < oldest.depth) oldest = { sha, depth };
  }
  if (!oldest || !gitOk(repo, 'rev-parse', '--verify', '-q', `${oldest.sha}^`)) return undefined;
  return git(repo, 'rev-parse', `${oldest.sha}^`).trim();
}

/**
 * La fiche a été amendée par l'un des commits `cites` (ceux qui citent le lot en cours) postérieur au commit rouge `red` (descendant strict) : seule voie d'ouverture de
 * l'exception L183 (L231). Un diff d'arbre de travail, un commit d'un autre lot ou un commit antérieur ou égal au rouge n'ouvre rien. Illisible pour git : non (le verrou reste entier).
 */
function ficheAmended(repo: string, red: string, fiche: string, cites: string[] = []): boolean {
  return cites.some((sha) => sha !== red && gitOk(repo, 'merge-base', '--is-ancestor', red, sha) && gitOk(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha, '--', fiche) && git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha, '--', fiche).trim() !== '');
}

/** Le premier commit fautif (L231) : le plus ancien commit après `since` qui a touché le chemin `file` (modification, suppression ou renommage, sans suivre les renommages), « <sha7> <sujet> » ; vide si aucun commit ne l'a touché (écart de l'arbre de travail). */
function firstCommitTouching(repo: string, since: string, file: string): string {
  try {
    const first = git(repo, 'log', '--reverse', '--format=%H %s', `${since}..HEAD`, '--', file).split('\n').find(Boolean);
    return first ? `${first.slice(0, 7)}${first.slice(40)}` : '';
  } catch {
    return '';
  }
}

/**
 * Le verrou (spec etape-spec § 5), valable pour toute session du dépôt : les tests d'acceptation de TOUS les lots sont inchangés depuis leur
 * commit rouge, au sens de git (arbre de travail compris), et chaque `acceptation.json` n'a bougé que par sa clé `vert` — posée par le
 * cycle, donc jamais modifiée pendant une session (comparée à `headBefore`). Vide = rien à signaler.
 * Un fichier neuf est un écart, sauf `skip` : le fichier du lot que l'étape accept est en train d'écrire, pas encore scellé (les autres lots restent
 * verrouillés, y compris contre un fichier d'un autre lot créé au passage). `rouge` : le commit rouge rangé dans l'état du cycle pour un fichier ; si
 * le dernier commit qui l'a réécrit n'est plus celui-là, une session précédente (interrompue, donc jamais comparée) l'a réécrit.
 * Exception (L183, resserrée par L231) : une acceptation à `vert: true` (lot livré) laisse modifier ses tests listés si sa fiche a été amendée par un commit de `lotCommits`
 * (ceux qui citent le lot en cours) postérieur à son commit rouge (descendant strict) : le lot en cours fait évoluer les règles. Une fois ouverte, l'exception couvre toute
 * l'acceptation (même commit que la fiche, commit ultérieur, session suivante). Un amendement par un autre lot, ou non commité (arbre de travail), n'ouvre rien. L'acceptation
 * du lot en cours garde le verrou entier. Le message d'un test modifié nomme le premier commit fautif (`firstCommitTouching`), absent quand aucun commit ne l'a touché.
 * Une fois livrée, une acceptation n'est plus comparée à son commit rouge (une évolution admise l'a dépassé et rien ne le rescelle) mais à `lotBase` :
 * un test changé avant ce point l'a été par un lot qui avait la fiche pour lui, et ses empreintes scellées ne valent plus.
 * Une seule exemption en plus (L184) : un fichier listé dont le contenu est identique à celui qu'il avait à `lotStart` (la tête d'avant le premier commit de
 * travail du lot, `lotStartHead`) n'est pas un écart : le bilan est nul sur le lot, qui a retiré son propre ajout (une reprise dans une nouvelle vague part d'un état déjà modifié). Un fichier absent à `lotStart` ou supprimé depuis n'a pas de contenu : jamais exempté ; la fiche changée depuis `lotStart` (évolution admise d'un autre lot) ôte l'exemption. Le filtre vaut pour toutes les acceptations, `vert: false` comprises.
 */
export function lockViolations(repo: string, dir: string, headBefore: string, opts: { skip?: string; rouge?: Record<string, string>; lotBase?: string; lotStart?: string; lotCommits?: string[]; lot?: string } = {}): string[] {
  const out: string[] = [];
  const before = new Set(listAcceptations(repo, dir, headBefore));
  const now = new Set(listAcceptations(repo, dir));
  for (const p of before) if (!now.has(p)) out.push(`${p} : acceptation.json supprimé (verrou des tests d'acceptation)`);
  for (const p of [...now].sort()) {
    if (p === opts.skip) continue;
    const isNew = !before.has(p);
    if (isNew) out.push(`${p} : acceptation.json créé hors de l'étape accept`);
    const red = redSha(repo, p);
    const cur = show(repo, 'HEAD', p);
    const base = red ? show(repo, red, p) : null;
    if (!red || !cur || !base) {
      out.push(`${p} : acceptation.json sans commit rouge lisible`);
      continue;
    }
    const anchor = opts.rouge?.[p];
    if (anchor && red !== anchor) out.push(`${p} : acceptation.json réécrit depuis son commit rouge ${anchor.slice(0, 7)} (réécriture commitée par une session interrompue ; seule la clé vert, posée par le cycle, peut changer)`);
    const was = isNew ? undefined : show(repo, headBefore, p);
    // Le commit rouge est le dernier changement du fichier : il ne bouge que si une session l'a réécrit, ce que la comparaison à la tête d'avant la session attrape.
    if (was && canon(cur) !== canon(was)) out.push(`${p} : acceptation.json réécrit pendant la session (seule la clé vert, posée par le cycle, peut changer)`);
    if (was && was.vert !== cur.vert) out.push(`${p} : clé vert changée pendant la session (elle est posée par le cycle)`);
    const fichiers = Array.isArray(base.fichiers) ? base.fichiers.filter((f): f is string => typeof f === 'string') : [];
    if (!fichiers.length) continue;
    let changed: string[] = [];
    try {
      changed = git(repo, 'diff', '--name-only', '-z', red, '--', ...fichiers).split('\0').filter(Boolean);
    } catch {
      changed = fichiers;
    }
    const sinceRed = changed; // livrée : ces fichiers ont pu évoluer avec la fiche, leur empreinte scellée ne vaut plus
    let depuis = red;
    if (cur.vert === true && typeof base.fiche === 'string' && base.lot !== opts.lot) {
      // L'acceptation du lot en cours (vert posé dès l'implement) garde le verrou entier : l'exception ne vaut que pour un lot suivant.
      const ref = opts.lotBase ?? headBefore;
      if (ficheAmended(repo, red, base.fiche, opts.lotCommits)) continue;
      // La référence ne quitte le commit rouge que si la fiche a évolué entre le rouge et `ref` : sinon tout test changé depuis le rouge reste un écart.
      if (gitOk(repo, 'diff', '--name-only', red, ref, '--', base.fiche) && git(repo, 'diff', '--name-only', red, ref, '--', base.fiche).trim() !== '') {
        depuis = ref;
        try {
          changed = git(repo, 'diff', '--name-only', '-z', ref, '--', ...fichiers).split('\0').filter(Boolean);
        } catch {
          changed = fichiers;
        }
      }
    }
    const lot = typeof base.lot === 'string' ? base.lot : '?';
    const emp = isObj(base.empreintes) ? base.empreintes : {};
    // Bilan nul sur le lot (L184) : contenu identique à celui d'avant le premier commit de travail du lot (un fichier absent à cette tête n'est jamais exempté).
    // Une fiche changée depuis cette tête (évolution admise d'un autre lot) ôte l'exemption : revenir à l'ancien contenu annulerait cette évolution, pas l'ajout du lot.
    const ficheMoved = typeof base.fiche === 'string' && opts.lotStart !== undefined && (!gitOk(repo, 'diff', '--quiet', opts.lotStart, '--', base.fiche));
    const unchangedByLot = (norm: string): boolean => {
      if (!opts.lotStart || ficheMoved) return false;
      const was = gitOk(repo, 'cat-file', '-e', `${opts.lotStart}:${norm}`) ? git(repo, 'rev-parse', `${opts.lotStart}:${norm}`).trim() : null;
      const now = existsSync(join(repo, norm)) ? git(repo, 'hash-object', '--', norm).trim() : null;
      return was !== null && was === now; // absent n'a pas de contenu : un fichier supprimé, ou créé par le lot (commit rouge), n'est jamais un bilan nul
    };
    changed = changed.filter((f) => !unchangedByLot(f));
    for (const f of fichiers) {
      const norm = posix.normalize(f); // sealAcceptation range les empreintes sous le chemin normalisé, et git diff le rend ainsi
      const want = emp[norm];
      if (typeof want !== 'string' || changed.includes(norm) || (depuis !== red && sinceRed.includes(norm)) || unchangedByLot(norm)) continue; // déjà signalé ci-dessus, ou bilan nul sur le lot
      const have = existsSync(join(repo, norm)) ? git(repo, 'hash-object', '--', norm).trim() : null;
      if (have !== want) out.push(`${f} : empreinte différente de celle du scellé de ${p} (test d'acceptation de ${lot})`);
    }
    for (const f of changed) {
      const culprit = firstCommitTouching(repo, depuis, f);
      out.push(`${f} : test d'acceptation de ${lot} : empreinte modifiée depuis ${depuis === red ? 'le commit rouge' : 'la tête d\'avant le lot'} ${depuis.slice(0, 7)} (verrou ${p})${culprit ? ` ; premier commit fautif : ${culprit}` : ''}`);
    }
  }
  return out;
}

/** Une liste (même d'un seul élément) lance chaque entrée sous sa racine ; une chaîne garde le dépôt pour racine. Le brief et le cycle décident par cette seule fonction. */
export function isAcceptList(accept: string | string[] | undefined): accept is string[] {
  return Array.isArray(accept);
}

/** Commandes de `orchestrate.accept` : une chaîne ou une liste (L189), toujours rendue en liste. */
export function acceptCommands(accept: string | string[] | undefined): string[] {
  return accept === undefined ? [] : isAcceptList(accept) ? accept : [accept];
}

/** Racine d'une commande : le dossier de son `cd <dossier> &&` initial (relatif au dépôt, normalisé), sinon le dépôt (''). Un `cd` qui sort du dépôt n'est pas une racine. */
export function acceptRoot(command: string): string {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command);
  const dir = posix.normalize(m?.[1] ?? m?.[2] ?? m?.[3] ?? '.');
  return dir === '.' || dir === '..' || dir.startsWith('../') || posix.isAbsolute(dir) ? '' : dir.replace(/\/$/, '');
}

/** Le fichier est sous la racine (le dépôt, '', contient tout). */
export const underRoot = (file: string, root: string): boolean => {
  const f = posix.normalize(file);
  return root === '' || f.startsWith(`${root}/`);
};

/** Lancements d'une liste de commandes (`single` : la chaîne seule de `orchestrate.accept`, dont la racine reste le dépôt, `cd` ou non, comme avant la liste) pour les fichiers de l'acceptation : une commande sans fichier sous sa racine n'est pas lancée ; un fichier sous aucune racine est un orphelin. */
export function planAcceptRuns(commands: string[], fichiers: string[], single = false): { runs: { command: string; root: string }[]; orphans: string[] } {
  const all = commands.map((command) => ({ command, root: single ? '' : acceptRoot(command) }));
  return { runs: all.filter((r) => fichiers.some((f) => underRoot(f, r.root))), orphans: fichiers.filter((f) => !all.some((r) => underRoot(f, r.root))) };
}

/** Consigne propre à l'étape accept dans le brief : fiche, maquette, commande dédiée, gabarit du lanceur, et les écarts de la passe précédente. */
export function acceptText(o: { fiche: string; maquette: string; screen?: boolean; back?: boolean; acceptation: string; command: string | string[]; test?: string; runner?: string; problems?: string[] }): string {
  const commands = acceptCommands(o.command);
  const screen = o.screen !== false;
  const lines = [
    !screen
      ? `Sheet: \`${o.fiche}\` (cases, rules, contracts, data). You get nothing else about the behaviour: the implementation does not exist yet.`
      : `Sheet: \`${o.fiche}\` (rules, fields, actions). Mockup: \`${o.maquette}\` (every field carries \`data-testid="<field id>"\`). You get nothing else about the screen: the implementation does not exist yet.${o.back ? ' The sheet also has a back part (`cas`, `contrats`, `donnees`): write the cases of its rules too, calling the contracts of `contrats[]` as close as possible and simulating the external sources from `entree`.' : ''}`,
    isAcceptList(o.command)
      ? `The project declares several dedicated commands (\`orchestrate.accept\`, one per test runner), each of which runs ONLY the acceptance tests of this lot that sit under its root (the folder of its leading \`cd <folder> &&\`, else the repository): ${commands.map((x) => `\`${x}\` (root \`${acceptRoot(x) || '.'}\`)`).join(', ')}. Each is run from the repository root and gets \`CADENCE_ACCEPTATION\` (the absolute path of the lot's \`acceptation.json\`, also substituted for \`{acceptation}\`) and \`CADENCE_ACCEPTATION_ROOT\` (its root); it takes only the files listed under its root, a command with no listed file under its root is not run, and a listed file under no root is refused. Put each test file where its runner looks, and list every file in \`fichiers\`.${o.test ? ` The project's ordinary test command is \`${o.test}\`: it must stay green with your red tests committed.` : ''}`
      : `The project declares the dedicated command that runs ONLY the acceptance tests of this lot (\`orchestrate.accept\`): \`${commands[0]}\` (from the repository root; the program sets \`CADENCE_ACCEPTATION\` to the absolute path of the lot's \`acceptation.json\`, and replaces \`{acceptation}\` with it).${o.test ? ` The project's ordinary test command is \`${o.test}\`: it must stay green with your red tests committed.` : ''}`,
    `If \`${o.acceptation}\` already exists with \`vert: true\` and \`empreintes\`, the lot's oracle is green and sealed: never rewrite it, nor its tests, \`resceaux\` or \`empreintes\`, and never set \`vert\` (a corrected test is resealed by the lead, \`cadence spec reseal\`). Write nothing, commit nothing, and hand the lot back with that finding in \`questions\`. A \`vert: true\` file WITHOUT \`empreintes\` (or whose \`empreintes\` lack one of the listed test files) was never sealed by the program (only the cycle sets \`vert\`, after the seal): it proves nothing, so write the oracle as described below, with \`vert: false\`.`,
    `Write \`${o.acceptation}\` (one file per lot, next to the sheet: another lot on the same ${screen ? 'screen' : 'subject'} has its own, which you never touch, nor its tests — give your test files names of your own): \`{ "lot": "<lot>", "fiche": "${o.fiche}", "fichiers": ["<test file>", …], "vert": false }\` (paths relative to the repository). If the tests need a build or a browser (Playwright, Chromium, \`dist\`), add \`"e2e": true\` to it: those files then stay out of the ordinary runner and the unit CI even once green (they would turn it red without \`dist\` or Chromium) and belong to the project's e2e suite, run after the build (\`acceptationE2e()\` of the runner template lists them). The ordinary test config of the project (shared with its CI) must exclude those files while \`vert\` is false; the dedicated config includes only them. Both read the file with this runner template (copy it into the project, e.g. \`tests/acceptation-runner.mjs\`):`,
  ];
  if (o.runner) lines.push('```js', o.runner.trimEnd(), '```');
  if (o.problems?.length) lines.push('', 'The program checked your previous pass and it did not pass; fix exactly these points (one more pass only, then the lot goes back to the lead):', ...o.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}
