import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { git } from './orchestrate-harness.js';

export const EXEMPLE = join(__dirname, '..', 'docs', 'superpowers', 'specs', '2026-10-10-etape-spec-fiche-exemple.yaml');

export interface Écrit {
  /** Modifie la fiche avant qu'elle soit écrite. */
  fiche?: (doc: any) => void;
  /** Largeurs/états dont la capture manque. */
  sansCapture?: string[];
  sansTestid?: string;
  sansSection?: string;
  /** Nom du dossier d'écran, s'il diffère de ecran.id. */
  dossier?: string;
  /** Racine des specs, si elle diffère de docs/specs. */
  racine?: string;
}

/** Ce que fait un agent spec : fiche, maquette, captures, un commit qui cite le lot. */
export function ecrit(cwd: string, o: Écrit = {}): string {
  const doc = parse(readFileSync(EXEMPLE, 'utf8')) as any;
  doc.ecran.lot = 'L1';
  o.fiche?.(doc);
  const nom = o.dossier ?? doc.ecran.id;
  const racine = o.racine ?? 'docs/specs';
  const dir = join(cwd, racine, nom);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fiche.yaml'), stringify(doc));
  const ids = (doc.champs as any[]).map((c) => c.id).filter((i) => i !== o.sansTestid);
  const html = [...ids.map((i) => `<p data-testid="${i}">${i}</p>`), ...(doc.etats as string[]).filter((e) => e !== o.sansSection).map((e) => `<section id="etat-${e}"></section>`)].join('\n');
  writeFileSync(join(dir, 'maquette.html'), `<!doctype html>\n${html}\n`);
  const files = ['fiche.yaml', 'maquette.html'];
  for (const e of doc.etats as string[]) {
    for (const w of [1440, 390]) {
      const f = `maquette-${e}-${w}.png`;
      if (o.sansCapture?.includes(f)) continue;
      writeFileSync(join(dir, f), 'png');
      files.push(f);
    }
  }
  const rel = files.map((f) => `${racine}/${nom}/${f}`);
  git(cwd, 'add', '--', ...rel);
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'feat(L1): spec prochain-match', '--', ...rel);
  return `${racine}/${nom}/fiche.yaml`;
}


export const EXEMPLE_BACK = join(__dirname, '..', 'docs', 'superpowers', 'specs', '2026-10-11-etape-spec-back-fiche-exemple.yaml');

interface ÉcritBack {
  /** Modifie la fiche avant qu'elle soit écrite. */
  fiche?: (doc: any) => void;
  /** Fiche mixte : la partie écran de l'exemple d'écran s'ajoute à la fiche back (ids A communs). */
  mixte?: boolean;
  /** Ne commite pas la fiche (écrite seulement). */
  sansCommit?: boolean;
}

/** La fiche back de l'exemple, au nom du lot L1 ; en fiche mixte, avec la partie écran de l'exemple d'écran. */
export function ficheBack(mixte = false): any {
  const f = parse(readFileSync(EXEMPLE_BACK, 'utf8')) as any;
  f.sujet.lot = 'L1';
  if (!mixte) return f;
  const e = parse(readFileSync(EXEMPLE, 'utf8')) as any;
  f.sujet.id = e.ecran.id;
  e.ecran.lot = 'L1';
  f.ecran = e.ecran;
  f.etats = e.etats;
  f.champs = e.champs;
  const n = f.regles.length;
  const decale = (id: string) => `R${Number(id.slice(1)) + n}`;
  for (const r of e.regles) f.regles.push({ ...r, id: decale(r.id), tests: r.tests.map((t: string) => t.replace(`${r.id} — `, `${decale(r.id)} — `)) });
  f.contrats.push({ id: 'A5', appel: 'POST /api/fixtures/next/reminder', entree: 'aucune', sortie: 'rappel enregistré', erreurs: [{ code: 'HTTP 409', message: 'Rappel déjà demandé' }], regles: [decale('R4')] });
  f.actions = [
    { id: 'A6', declencheur: 'bouton-rappel', contrat: 'A5', regles: [decale('R4')] },
    { id: 'A7', declencheur: null, contrat: 'A1', regles: [decale('R2'), decale('R3')] },
  ];
  return f;
}

/** Ce que fait un agent spec sur un lot back : la fiche seule, dans docs/specs/<sujet>/, commitée et citant le lot. */
export function ecritBack(cwd: string, o: ÉcritBack = {}): string {
  const doc = ficheBack(o.mixte);
  o.fiche?.(doc);
  const racine = 'docs/specs';
  const dir = join(cwd, racine, doc.sujet.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fiche.yaml'), stringify(doc));
  const rel = [`${racine}/${doc.sujet.id}/fiche.yaml`];
  if (o.mixte) {
    const html = [...(doc.champs as any[]).map((c) => `<p data-testid="${c.id}">${c.id}</p>`), ...(doc.etats as string[]).map((e) => `<section id="etat-${e}"></section>`)].join('\n');
    writeFileSync(join(dir, 'maquette.html'), `<!doctype html>\n${html}\n`);
    rel.push(`${racine}/${doc.sujet.id}/maquette.html`);
    for (const e of doc.etats as string[]) for (const w of [1440, 390]) {
      writeFileSync(join(dir, `maquette-${e}-${w}.png`), 'png');
      rel.push(`${racine}/${doc.sujet.id}/maquette-${e}-${w}.png`);
    }
  }
  if (!o.sansCommit) {
    git(cwd, 'add', '--', ...rel);
    git(cwd, 'commit', '-q', '--allow-empty', '-m', `spec(L1): fiche ${doc.sujet.id}`, '--', ...rel);
  }
  return rel[0];
}
