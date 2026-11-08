import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface Regles { autorises: string[]; certains: string[]; runs: string }
export interface Fuites { certaines: string[]; a_verifier: string[] } // R21 : à vérifier = le reste de runs (ancêtres du clone, globs d'ancêtres)

export const dossierTranscripts = (home: string, cwd: string) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

export function reglesDuBras(home: string, racine: string, banc: string, clone: string): Regles {
  return {
    autorises: [clone, `${clone}.captures`, `${clone}.question.md`, join(racine, 'bancs', banc), dossierTranscripts(home, clone)],
    certains: [join(racine, 'secrets'), join(racine, 'bancs'), join(home, 'projects'), join(home, '.claude', 'projects')], runs: join(racine, 'runs'),
  };
}

function* textes(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* textes(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* textes(x);
}

const sous = (p: string, prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));

function accolades(t: string): string[] {
  const m = /^(.*?)\{([^{}$]*,[^{}]*)\}(.*)$/s.exec(t);
  return m ? m[2].split(',').flatMap((x) => accolades(m[1] + x + m[3])) : [t];
}

// Chemin absolu du jeton (~, $HOME, absolu, ou relatif à cwd s'il contient « / » ou « .. »), sinon null.
function resoudre(tok: string, cwd: string, home: string, rel: boolean, cd = false): string | null {
  const t = tok.replace(/(?<![./])\.+$/, '').replace(/[,:]+$/, '');
  if (/^(~|\$HOME)(\/|$)/.test(t)) return resolve(home, t.replace(/^(~|\$HOME)\/?/, ''));
  if (t.startsWith('/')) return resolve(t);
  return rel && (cd || t.includes('/') || t === '..') ? resolve(cwd, t) : null;
}

export function chercherFuites(lignes: string[], r: Regles, home: string, cwd = ''): Fuites {
  const vus = { certaines: new Set<string>(), a_verifier: new Set<string>() };
  const juger = (p: string | null) => {
    const g = p ? p.search(/[*?[]/) : -1; // glob : seul le préfixe littéral compte
    if (p && g >= 0) p = p.slice(0, p.lastIndexOf('/', g)) || '/';
    if (!p || sous(p, r.autorises)) return;
    if (sous(p, r.certains) || p.slice(r.runs.length + 1).split('/').slice(2).some((x) => /^c\d+$/.test(x)) && sous(p, [r.runs])) vus.certaines.add(p);
    else if (sous(p, [r.runs])) vus.a_verifier.add(p);
  };
  const depart = cwd || r.autorises[0];
  for (const l of lignes) {
    let d: { type?: string; cwd?: string; message?: { content?: { type: string; name?: string; input?: unknown }[] } };
    try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant') continue;
    for (const c of d.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      if (c.name === 'Bash' && typeof d.cwd === 'string' && isAbsolute(d.cwd)) juger(resolve(d.cwd));
      const cmd = (c.input as { command?: unknown } | undefined)?.command;
      const sources: [string, boolean][] = [...[...textes(c.input)].map((t): [string, boolean] => [t, false]),
        ...(c.name === 'Bash' && typeof cmd === 'string' ? [[cmd, true] as [string, boolean]] : [])];
      for (const [texte, rel] of sources) {
        let dir = rel && typeof d.cwd === 'string' && isAbsolute(d.cwd) ? d.cwd : depart;
        for (const seg of texte.replace(/\$\{HOME\}/g, '$HOME').split(/&&|\|\||;|\n/)) {
          for (const v of accolades(seg)) {
            const cd = rel ? /^\s*cd\s+(\S+)/.exec(v) : null;
            const cible = cd ? resoudre(cd[1].replace(/^['"]|['"]$/g, ''), dir, home, true, true) : null;
            for (const tok of v.split(/[\s'"`|&<>(){}=]+/)) juger(resoudre(tok, dir, home, rel));
            if (cible) dir = cible;
          }
        }
      }
    }
  }
  return { certaines: [...vus.certaines], a_verifier: [...vus.a_verifier] };
}

function jsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? jsonl(p) : p.endsWith('.jsonl') ? [p] : [];
  });
}

export function fuitesDuBras(home: string, racine: string, banc: string, clone: string): Fuites {
  const lignes = jsonl(dossierTranscripts(home, clone)).flatMap((f) => readFileSync(f, 'utf8').split('\n'));
  return chercherFuites(lignes, reglesDuBras(home, racine, banc, clone), home, clone);
}
