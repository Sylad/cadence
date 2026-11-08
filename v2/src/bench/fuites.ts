import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface Regles { autorises: string[]; certains: string[]; runs: string }
export interface Fuites { certaines: string[]; a_verifier: string[] } // R21 : à vérifier = le reste de runs (ancêtres du clone, globs d'ancêtres)

export const dossierTranscripts = (home: string, cwd: string) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

export function reglesDuBras(home: string, racine: string, banc: string, clone: string): Regles {
  return {
    autorises: [clone, `${clone}.captures`, `${clone}.question.md`, `${clone}.install.log`, `${clone}.tests-base.log`, join(racine, 'bancs', banc), dossierTranscripts(home, clone)],
    certains: [join(racine, 'secrets'), join(racine, 'eval'), join(racine, 'rapports'), join(racine, 'bancs'), join(home, 'projects'), join(home, '.claude', 'projects')], runs: join(racine, 'runs'),
  };
}

function* textes(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* textes(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* textes(x);
}

const sous = (p: string, prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));

const globale = (x: string) => { try { return new RegExp(`^${x.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`); } catch { return /./; } };

function accolades(t: string): string[] {
  const m = /^(.*?)\{([^{}$]*,[^{}]*)\}(.*)$/s.exec(t);
  return m ? m[2].split(',').flatMap((x) => accolades(m[1] + x + m[3])) : [t];
}

// Chemin absolu du jeton (~, $HOME, absolu, ou relatif à cwd s'il contient « / » ou « .. »), sinon null.
function resoudre(tok: string, cwd: string, home: string, rel: boolean, cd = false): string | null {
  const t = tok.replace(/(?<![./])\.+$/, '').replace(/[,:]+$/, '');
  if (/^(~|\$HOME)(\/|$)/.test(t)) return resolve(home, t.replace(/^(~|\$HOME)\/?/, ''));
  if (t.startsWith('/')) return resolve(t);
  return rel && (cd || t.includes('/') || t === '..' || /^c\d+/.test(t)) ? resolve(cwd, t) : null;
}

export function chercherFuites(lignes: string[], r: Regles, home: string, cwd = ''): Fuites {
  const vus = { certaines: new Set<string>(), a_verifier: new Set<string>() };
  const juger = (p: string | null) => {
    if (!p) return;
    const g = p.search(/[*?[]/); // glob : préfixe littéral ; en cas de doute (composant pouvant désigner un clone voisin), certaine
    const pre = g >= 0 ? p.slice(0, p.lastIndexOf('/', g)) || '/' : p;
    if (sous(pre, r.autorises)) return;
    const sousRuns = sous(pre, [r.runs]);
    const comps = sousRuns ? p.slice(r.runs.length + 1).split('/').slice(2) : [];
    const premier = comps.findIndex((x) => /[*?[]/.test(x)); // seul le premier composant à glob peut désigner un dossier de clone
    if (sous(pre, r.certains) || comps.some((x, i) => /^c\d+(\.|$)/.test(x) || (i === premier && globale(x).test('c2'))))  vus.certaines.add(pre);
    else if (sousRuns) vus.a_verifier.add(pre);
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
            juger(cible); if (cible) dir = cible;
          }
        }
      }
    }
  }
  return { certaines: [...vus.certaines], a_verifier: [...vus.a_verifier] };
}

export function jsonl(dir: string): string[] {
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
