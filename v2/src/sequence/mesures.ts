import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export class CloneModifie extends Error {}
export interface ResultatTests { passes: number; total: number; echoues: string[]; statuts: Record<string, boolean> }
interface Vitest { testResults?: { name: string; assertionResults?: { ancestorTitles?: string[]; title: string; status: string }[] }[] }

const git = (clone: string, ...a: string[]) => execFileSync('git', a, { cwd: clone, encoding: 'utf8', maxBuffer: 256 << 20 });
const etat = (clone: string) => [git(clone, 'status', '--porcelain'), git(clone, 'ls-files', '--others', '--exclude-standard')].join('\n--\n');

/** Joue des tests cachés dans le clone, puis le rend identique à l'avant (sinon CloneModifie). Id d'un test : « dest > ancêtres > titre ». */
export function jouerTests(clone: string, fichiers: { src: string; dest: string }[], commande: string, delaiMs: number): ResultatTests {
  const avant = etat(clone);
  const tmp = mkdtempSync(join(tmpdir(), 'banc-tests-'));
  const sortie = join(tmp, 'resultat.json');
  const copies = fichiers.map((f) => {
    const dest = isAbsolute(f.dest) ? f.dest : join(clone, f.dest);
    const copie = /\.spec\.\w+$/.test(dest) ? dest.replace(/\.spec(\.\w+)$/, '.banc-cache.spec$1') : `${dest.replace(/\.[^./]+$/, '')}.banc-cache.spec.ts`;
    return { ...f, id: relative(clone, dest), copie };
  });
  try {
    for (const c of copies) { mkdirSync(join(c.copie, '..'), { recursive: true }); copyFileSync(c.src, c.copie); }
    try {
      execSync(`${commande} ${copies.map((c) => JSON.stringify(c.copie)).join(' ')} --reporter=json --outputFile=${sortie}`,
        { cwd: clone, timeout: delaiMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
    } catch (e) { if (!existsSync(sortie)) throw e; } // vitest sort en 1 quand un test est rouge : le JSON fait foi
  } finally {
    for (const c of copies) rmSync(c.copie, { force: true });
  }
  if (etat(clone) !== avant) throw new CloneModifie(`le clone ${clone} n'est plus identique après les tests cachés : ${etat(clone).replace(avant, "").trim()}`);
  if (!existsSync(sortie)) throw new Error('la commande de test n\'a produit aucun JSON');
  const json = JSON.parse(readFileSync(sortie, 'utf8')) as Vitest;
  const statuts: Record<string, boolean> = {};
  for (const r of json.testResults ?? []) {
    const c = copies.find((x) => resolve(clone, r.name) === x.copie);
    for (const t of r.assertionResults ?? []) statuts[[c?.id ?? r.name, ...(t.ancestorTitles ?? []), t.title].join(' > ')] = t.status === 'passed';
  }
  const ids = Object.keys(statuts);
  return { passes: ids.filter((i) => statuts[i]).length, total: ids.length, echoues: ids.filter((i) => !statuts[i]), statuts };
}

/** Tests passés à une étape antérieure et rouges maintenant. Un rouge d'avant, ou un test absent d'avant, n'en est pas un. */
export const regressions = (avant: Record<string, boolean>, apres: Record<string, boolean>): string[] =>
  Object.keys(avant).filter((k) => avant[k] === true && apres[k] === false);

const ECRITURES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** Lectures des pièces de référence AVANT la première écriture dans le clone (sans `clone`, toute écriture compte). */
export function lectureReferences(lignes: string[], pieces: string[], clone?: string): { ouvertes: string[]; manquantes: string[]; apres_ecriture: string[]; partielles: string[] } {
  const cibles = new Map(pieces.map((p) => [resolve(p), p]));
  const dedans = (p: string) => !clone || resolve(p) === resolve(clone) || resolve(p).startsWith(`${resolve(clone)}/`);
  const avant = new Set<string>(), apres = new Set<string>(), entieres = new Set<string>();
  let ecrit = false;
  for (const l of lignes) {
    let d: { type?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
    try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant') continue;
    for (const c of d.message?.content ?? []) {
      const f = c.input?.file_path;
      if (c.type !== 'tool_use' || typeof f !== 'string') continue;
      if (ECRITURES.includes(c.name ?? '') && dedans(f)) ecrit = true;
      const piece = c.name === 'Read' ? cibles.get(resolve(f)) : undefined;
      if (!piece) continue;
      if (ecrit) apres.add(piece);
      else { avant.add(piece); if (c.input?.pages === undefined && c.input?.limit === undefined && c.input?.offset === undefined) entieres.add(piece); }
    }
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
    return statSync(p).isDirectory() ? fichiers(p) : SOURCES.test(p) ? [p] : [];
  });
}

/** Duplication (jscpd, null si indisponible, jamais 0) et tailles de fichiers des dossiers donnés. */
export function maintenabilite(clone: string, dossiers: string[], jscpd: string[] = ['npx', '--yes', 'jscpd@4']): { duplication_pct: number | null; plus_gros: { fichier: string; lignes: number }[]; fichiers_400: number } {
  const tailles = dossiers.flatMap((d) => fichiers(join(clone, d))).map((f) => ({ fichier: relative(clone, f), lignes: readFileSync(f, 'utf8').split('\n').length }))
    .sort((a, b) => b.lignes - a.lignes);
  let duplication_pct: number | null = null;
  const sortie = mkdtempSync(join(tmpdir(), 'banc-jscpd-'));
  try {
    execFileSync(jscpd[0], [...jscpd.slice(1), ...dossiers.map((d) => join(clone, d)), '--reporters', 'json', '--output', sortie, '--silent'], { timeout: 300_000, stdio: 'ignore' });
    const p = (JSON.parse(readFileSync(join(sortie, 'jscpd-report.json'), 'utf8')) as { statistics?: { total?: { percentage?: number } } }).statistics?.total?.percentage;
    duplication_pct = typeof p === 'number' ? p : null;
  } catch { duplication_pct = null; } finally { rmSync(sortie, { recursive: true, force: true }); }
  return { duplication_pct, plus_gros: tailles.slice(0, 5), fichiers_400: tailles.filter((t) => t.lignes > 400).length };
}
