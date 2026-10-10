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

