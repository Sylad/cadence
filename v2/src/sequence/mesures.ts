import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { appelsOutils, cheminOutil, dansClone, ECRITURES, lectureEntiere } from '../../hooks/lecture.mjs';

export class CloneModifie extends Error {}
export class TestsIntrouvables extends Error {}
export interface ResultatTests { passes: number; total: number; echoues: string[]; statuts: Record<string, boolean>; ignores: number; fichiers_en_erreur: string[] }
interface Vitest { testResults?: { name: string; status?: string; assertionResults?: { ancestorTitles?: string[]; title: string; status: string }[] }[] }

const git = (clone: string, ...a: string[]) => execFileSync('git', a, { cwd: clone, encoding: 'utf8', maxBuffer: 256 << 20 });
const sha = (f: string) => (existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex') : 'absent');
const lignes = (t: string) => t.split('\n').filter(Boolean);
/** Contenu du clone : sha de chaque fichier suivi modifié et de chaque fichier non suivi (le texte de `git status` ne voit pas un contenu qui change). */
function etat(clone: string): { sales: Map<string, string>; neufs: Map<string, string> } {
  const f = (chemins: string[]) => new Map(chemins.map((c) => [c, sha(join(clone, c))]));
  return { sales: f(lignes(git(clone, 'diff', 'HEAD', '--name-only'))), neufs: f(lignes(git(clone, 'ls-files', '--others', '--exclude-standard'))) };
}
const COPIE = /\.banc-cache\./;
function balayer(dir: string): void { // reste d'un run planté : copies cachées et leurs snapshots
  for (const e of existsSync(dir) ? readdirSync(dir) : []) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (lstatSync(p).isDirectory()) balayer(p); else if (COPIE.test(e)) rmSync(p, { force: true });
  }
}
/** Nom de la copie : `<base>.banc-cache.<spec|test>.<ext>` garde le suffixe que l'include du projet attend. */
const nomCopie = (dest: string) => (/\.(spec|test)\.\w+$/.test(dest) ? dest.replace(/\.(spec|test)(\.\w+)$/, '.banc-cache.$1$2') : `${dest.replace(/\.[^./]+$/, '')}.banc-cache.spec.ts`);
const sortie = (tmp: string) => { const f = readdirSync(tmp).find((x) => x.endsWith('.json')); return f && join(tmp, f); };
const STATUTS_IGNORES = ['skipped', 'pending', 'todo', 'disabled'];

/** Joue des tests (cachés copiés, ou la suite du projet sans copie) dans le clone, puis le rend identique à l'avant (sinon CloneModifie, après restauration).
 * Id : « dest > ancêtres > titre » (doublon : « #2 ») ; sans copie, chemin relatif au clone. `commande` avec `<sortie>` : dossier du JSON (flags du reporter fournis, vitest ou jest).
 * `garder` : copie du JSON brut, hors du clone. `connus` : ids déjà vus à une étape précédente ; un fichier en erreur d'import les passe tous au rouge. Rien de trouvé = TestsIntrouvables. */
export function jouerTests(clone: string, fichiers: { src: string; dest: string }[], commande: string, delaiMs: number, connus: string[] = [], garder?: string): ResultatTests {
  balayer(clone);
  const avant = etat(clone);
  const tmp = mkdtempSync(join(tmpdir(), 'banc-tests-'));
  const copies = fichiers.map((f) => {
    const dest = isAbsolute(f.dest) ? f.dest : join(clone, f.dest);
    return { ...f, id: relative(clone, dest), copie: nomCopie(dest) };
  });
  const dossiers: string[] = [];
  let erreur: unknown;
  try {
    for (const c of copies) if (existsSync(c.copie)) throw new Error(`la copie ${c.copie} existe déjà`);
    for (const c of copies) {
      let d = join(c.copie, '..'); const neufs: string[] = [];
      while (!existsSync(d)) { neufs.push(d); d = join(d, '..'); }
      dossiers.push(...neufs);
      mkdirSync(join(c.copie, '..'), { recursive: true }); copyFileSync(c.src, c.copie);
    }
    try {
      const f = copies.map((c) => JSON.stringify(c.copie)).join(' ');
      execSync(commande.includes('<sortie>') ? `${commande.replaceAll('<sortie>', tmp)} ${f}` : `${commande} ${f} --reporter=json --outputFile=${join(tmp, 'resultat.json')}`,
        { cwd: clone, timeout: delaiMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
    } catch (e) { // vitest sort en 1 quand un test est rouge : le JSON fait foi
      if (!sortie(tmp)) throw /No test files found/.test(String((e as { stdout?: string }).stdout) + String((e as { stderr?: string }).stderr)) ? new TestsIntrouvables('vitest n\'a trouvé aucun des fichiers copiés') : e;
    }
  } catch (e) { erreur = e; } finally {
    for (const c of copies) { rmSync(c.copie, { force: true }); rmSync(join(c.copie, '..', '__snapshots__', `${basename(c.copie)}.snap`), { force: true }); }
    for (const d of dossiers.flatMap((x) => [join(x, '__snapshots__'), x])) { try { rmdirSync(d); } catch { /* non vide ou déjà parti */ } }
  }
  const apres = etat(clone);
  const restes: string[] = [], intouches: string[] = [];
  for (const [m, neuf] of [[apres.neufs, avant.neufs], [apres.sales, avant.sales]] as const) {
    for (const [c, h] of m) {
      if (!neuf.has(c)) { restes.push(c); (m === apres.neufs ? rmSync(join(clone, c), { force: true }) : git(clone, 'checkout', '--', c)); }
      else if (neuf.get(c) !== h) intouches.push(c); // déjà sale avant : on ne le touche pas, on le dit
    }
    for (const c of neuf.keys()) if (!m.has(c)) intouches.push(c);
  }
  if (restes.length || intouches.length) {
    rmSync(tmp, { recursive: true, force: true });
    throw new CloneModifie(`le clone ${clone} n'est plus identique après les tests cachés : restauré ${restes.join(', ') || 'rien'} ; non touché ${intouches.join(', ') || 'rien'}${erreur ? ` (erreur de la commande : ${String(erreur)})` : ''}`);
  }
  try {
    if (erreur) throw erreur;
    const s = sortie(tmp);
    if (!s) throw new Error('la commande de test n\'a produit aucun JSON');
    if (garder) copyFileSync(s, garder);
    return lire(JSON.parse(readFileSync(s, 'utf8')) as Vitest, copies, clone, connus);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function lire(json: Vitest, copies: { id: string; copie: string }[], clone: string, connus: string[]): ResultatTests {
  const statuts: Record<string, boolean> = {};
  const en_erreur: string[] = [], vus = new Set<string>();
  let ignores = 0;
  for (const r of json.testResults ?? []) {
    const c = copies.find((x) => resolve(clone, r.name) === x.copie);
    const id = c?.id ?? relative(clone, resolve(clone, r.name));
    if (c) vus.add(c.id);
    const tests = r.assertionResults ?? [];
    if (!tests.length && r.status === 'failed') { // import cassé : rien n'a tourné, rien ne doit compter comme vert
      en_erreur.push(id);
      statuts[`${id} > (fichier en erreur)`] = false;
      for (const k of connus) if (k.startsWith(`${id} > `)) statuts[k] = false;
    }
    for (const t of tests) {
      if (STATUTS_IGNORES.includes(t.status)) { ignores++; continue; }
      const base = [id, ...(t.ancestorTitles ?? []), t.title].join(' > ');
      let k = base; for (let n = 2; k in statuts; n++) k = `${base} #${n}`;
      statuts[k] = t.status === 'passed';
    }
  }
  const absents = copies.filter((c) => !vus.has(c.id)).map((c) => c.id);
  if (absents.length) throw new TestsIntrouvables(`aucun résultat pour ${absents.join(', ')} (filtré par l'include du projet ?)`);
  const ids = Object.keys(statuts);
  if (!ids.length) throw new TestsIntrouvables('aucun test n\'a tourné');
  return { passes: ids.filter((i) => statuts[i]).length, total: ids.length, echoues: ids.filter((i) => !statuts[i]), statuts, ignores, fichiers_en_erreur: en_erreur };
}

// Limites connues : une écriture par Bash (sed -i, tee, redirection) n'est pas vue. Les lectures et écritures des sous-agents (sidechain)
// COMPTENT : le bras a délégué, la lecture a eu lieu. « Lire » et « écrire » : hooks/lecture.mjs, la définition du hook du bras candidat.
/** Lectures des pièces de référence AVANT la première écriture dans le clone (sans `clone`, toute écriture compte). */
export function lectureReferences(lignes: string[], pieces: string[], clone?: string): { ouvertes: string[]; manquantes: string[]; apres_ecriture: string[]; partielles: string[] } {
  const cibles = new Map(pieces.map((p) => [resolve(p), p]));
  const avant = new Set<string>(), apres = new Set<string>(), entieres = new Set<string>();
  let ecrit = false;
  for (const c of lignes.flatMap(appelsOutils)) {
    const f = cheminOutil(c.input);
    if (!f) continue;
    if (ECRITURES.includes(c.name) && (!clone || dansClone(f, clone))) ecrit = true;
    const piece = c.name === 'Read' ? cibles.get(resolve(f)) : undefined;
    if (!piece) continue;
    if (ecrit) apres.add(piece);
    else { avant.add(piece); if (lectureEntiere(c.input)) entieres.add(piece); }
  }
  return { ouvertes: pieces.filter((p) => avant.has(p)), manquantes: pieces.filter((p) => !avant.has(p) && !apres.has(p)),
    apres_ecriture: pieces.filter((p) => !avant.has(p) && apres.has(p)), partielles: pieces.filter((p) => avant.has(p) && !entieres.has(p)) };
}

const SOURCES = /\.(ts|tsx|js|java|py|html|scss|css)$/;
function fichiers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    if (e === 'node_modules' || e === 'dist' || e === '.git') return [];
    const p = join(dir, e);
    const l = lstatSync(p); // liens symboliques ignorés (un lien cassé ferait échouer la lecture)
    return l.isDirectory() ? fichiers(p) : l.isFile() && SOURCES.test(p) ? [p] : [];
  });
}

/** Duplication (jscpd, null si indisponible, jamais 0) et tailles de fichiers des dossiers donnés. */
export function maintenabilite(clone: string, dossiers: string[], jscpd: string[] = ['npx', '--yes', 'jscpd@4']): { duplication_pct: number | null; raison?: string; plus_gros: { fichier: string; lignes: number }[]; fichiers_400: number } {
  const tailles = dossiers.flatMap((d) => fichiers(join(clone, d))).map((f) => ({ fichier: relative(clone, f), lignes: readFileSync(f, 'utf8').split('\n').length }))
    .sort((a, b) => b.lignes - a.lignes);
  let duplication_pct: number | null = null, raison: string | undefined;
  const sortie = mkdtempSync(join(tmpdir(), 'banc-jscpd-'));
  try {
    execFileSync(jscpd[0], [...jscpd.slice(1), ...dossiers.map((d) => join(clone, d)), '--ignore', '**/node_modules/**', '--reporters', 'json', '--output', sortie, '--silent'], { timeout: 300_000, stdio: 'ignore' });
    const p = (JSON.parse(readFileSync(join(sortie, 'jscpd-report.json'), 'utf8')) as { statistics?: { total?: { percentage?: number } } }).statistics?.total?.percentage;
    if (typeof p === 'number') duplication_pct = p; else raison = 'rapport jscpd sans pourcentage';
  } catch (e) { raison = (e as Error).message; } finally { rmSync(sortie, { recursive: true, force: true }); }
  return { duplication_pct, ...(raison ? { raison } : {}), plus_gros: tailles.slice(0, 5), fichiers_400: tailles.filter((t) => t.lignes > 400).length };
}
