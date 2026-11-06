import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// L605 (E16) : docs/stabilite.md dit le statut de chaque surface que le code lit.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

const page = read('docs/stabilite.md');
const guaranteed = page.slice(page.indexOf('**Guaranteed**'), page.indexOf('**Experimental**'));
const experimental = page.slice(page.indexOf('**Experimental**'), page.indexOf('**Not guaranteed**'));

/** Les noms de la table `name: ` ou `'name': ` d'un `Record` de src/cli.ts, du `const X = {` à la ligne `};`. */
function tableKeys(source: string, table: string): string[] {
  const start = source.indexOf(`const ${table}`);
  const body = source.slice(source.indexOf('{', source.indexOf('=', start)), source.indexOf('\n};', start));
  return [...body.matchAll(/^  '?([a-z][a-z-]*)'?:/gm)].map((m) => m[1]!);
}

/** Les puces d'une liste, par leur début, sans leur intitulé (jusqu'au premier « : », où `raf` se nomme lui-même) : les commandes et les outils d'un côté, les clés du cadence.yaml de l'autre (`plan` est les deux). */
const bullets = (section: string, start: RegExp): string => section.split('\n- ').filter((b) => start.test(b)).map((b) => b.slice(b.indexOf(':') + 1)).join('\n');
const COMMANDS = /^\*\*(Commands|Subcommands|Tools)/;
const KEYS = /^\*\*(The keys|Keys)/;

const status = (name: string, kind: 'command' | 'key'): string[] => {
  const re = new RegExp('`(?:cadence )?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[`.:( ]');
  const start = kind === 'command' ? COMMANDS : KEYS;
  return [guaranteed, experimental].flatMap((s, i) => (re.test(bullets(s, start)) ? [i === 0 ? 'guaranteed' : 'experimental'] : []));
};

describe('stabilite.md — le statut de chaque surface que le code lit (L605)', () => {
  it('R1 — la page a une liste Guaranteed et une liste Experimental, dans cet ordre', () => {
    expect(page.indexOf('**Guaranteed**')).toBeGreaterThan(-1);
    expect(page.indexOf('**Experimental**')).toBeGreaterThan(page.indexOf('**Guaranteed**'));
    expect(page.indexOf('**Not guaranteed**')).toBeGreaterThan(page.indexOf('**Experimental**'));
  });

  it('R2 — chaque sous-commande des tables de dispatch de src/cli.ts a un statut, et un seul', () => {
    const cli = read('src/cli.ts');
    const names = [...new Set([...tableKeys(cli, 'BEFORE_PLAN'), ...tableKeys(cli, 'WITH_PLAN')])];
    expect(names.length).toBeGreaterThan(30);
    const sansStatut = names.filter((n) => status(n, 'command').length === 0);
    const doubles = names.filter((n) => status(n, 'command').length > 1);
    expect(sansStatut, 'sous-commandes sans statut dans stabilite.md').toEqual([]);
    expect(doubles, 'sous-commandes à la fois garanties et expérimentales').toEqual([]);
  });

  it('R3 — chaque outil de bin/cadence.js a un statut, et un seul', () => {
    const bin = read('bin/cadence.js');
    const list = /\[((?:'[a-z-]+',? ?)+)\]\.includes\(tool\)/.exec(bin)![1]!;
    const tools = ['raf', ...[...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)];
    expect(tools.length).toBe(17);
    // `raf` est l'outil de base : ses sous-commandes sont le sujet de R2.
    for (const t of tools.filter((x) => x !== 'raf')) expect(status(t, 'command'), t).toHaveLength(1);
  });

  it('R4 — chaque clé racine du cadence.yaml lue par le code a un statut, et un seul', () => {
    const keys = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) for (const m of read(p).matchAll(/readYamlKey\(\w+, '([a-zA-Z]+)'\)/g)) keys.add(m[1]!);
      }
    };
    walk('src');
    for (const k of ['resources', 'docs', 'qa']) keys.add(k);
    expect([...keys]).toEqual(expect.arrayContaining(['plan', 'verify', 'references', 'migrate', 'perf', 'news']));
    for (const k of keys) expect(status(k, 'key'), k).toHaveLength(1);
  });

  it('R5 — les surfaces qui peuvent encore bouger sont dites expérimentales, les autres garanties, la raison à côté', () => {
    for (const n of ['quickwins', 'uses', 'plan', 'docs-ok', 'ref', 'perf', 'local', 'release', 'config']) {
      expect(status(n, 'command'), n).toEqual(['experimental']);
    }
    for (const n of ['references', 'perf']) expect(status(n, 'key'), n).toEqual(['experimental']);
    for (const n of ['archive', 'estimate', 'move', 'title', 'todo', 'status', 'import', 'migrate', 'verify']) {
      expect(status(n, 'command'), n).toEqual(['guaranteed']);
    }
    for (const n of ['verify', 'migrate', 'resources', 'plan']) expect(status(n, 'key'), n).toEqual(['guaranteed']);
    expect(experimental).toMatch(/promoting .* is a minor change/i);
  });
});
