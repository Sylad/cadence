import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Regles { autorises: string[]; interdits: string[] }

export const dossierTranscripts = (home: string, cwd: string) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

export function reglesDuBras(home: string, racine: string, banc: string, clone: string): Regles {
  return {
    autorises: [clone, `${clone}.captures`, `${clone}.question.md`, join(racine, 'bancs', banc), dossierTranscripts(home, clone)],
    interdits: [join(racine, 'secrets'), join(racine, 'runs'), join(racine, 'bancs'), join(home, 'projects'), join(home, '.claude', 'projects')],
  };
}

function* textes(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* textes(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* textes(x);
}

const CHEMIN = /(?:~|\$HOME|\/home\/[^/\s'"`]+)(\/[^\s'"`;|&<>(){}]*)/g;
const sous = (p: string, prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));

export function chercherFuites(lignes: string[], r: Regles, home: string): string[] {
  const vus = new Set<string>();
  for (const l of lignes) {
    let d: { type?: string; message?: { content?: { type: string; input?: unknown }[] } };
    try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant') continue;
    for (const c of d.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      for (const t of textes(c.input)) for (const m of t.matchAll(CHEMIN)) {
        const p = (m[0].startsWith('/home/') ? m[0] : home + m[1]).replace(/[.,:]+$/, '');
        if (sous(p, r.interdits) && !sous(p, r.autorises)) vus.add(p);
      }
    }
  }
  return [...vus];
}

function jsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? jsonl(p) : p.endsWith('.jsonl') ? [p] : [];
  });
}

export function fuitesDuBras(home: string, racine: string, banc: string, clone: string): string[] {
  const lignes = jsonl(dossierTranscripts(home, clone)).flatMap((f) => readFileSync(f, 'utf8').split('\n'));
  return chercherFuites(lignes, reglesDuBras(home, racine, banc, clone), home);
}
