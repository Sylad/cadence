import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { LECTURE_PAGES_MAX } from '../src/ref/analyse.js';
import { tempDir } from './helpers.js';
import { stubTools, writePdf, type FixturePage } from './ref-fixture.js';

const root = join(import.meta.dirname, '..');
const AGENT = readFileSync(join(root, 'agents', 'reference-analyst.md'), 'utf8');

type Obj = Record<string, any>;

/**
 * Faux `claude` (CADENCE_CLAUDE_BIN) : relit son brief, journalise l'appel (FAKE_LOG) et, selon FAKE_MODE, écrit la lecture
 * `lectures/a.json` que le brief nomme, puis rend une sortie `claude -p --output-format json` de 100 + 400 + 500 jetons comptés.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const brief = args[args.indexOf('-p') + 1];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), brief }) + '\\n');
const mode = process.env.FAKE_MODE || 'ok';
const out = (o) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-1', num_turns: 4, duration_ms: 10, result: '', usage: { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 9000, output_tokens: 500 }, ...o }));
if (mode === 'quota') { out({ is_error: true, subtype: 'error', result: 'Claude usage limit reached | resets at 5pm' }); process.exit(0); }
if (mode === 'crash') { process.stderr.write('boom'); process.exit(1); }
const file = /(\\S+\\/lectures\\/a\\.json)/.exec(brief)[1];
const doc = JSON.parse(fs.readFileSync(file.replace('/lectures/a.json', '/document.json'), 'utf8'));
const texte = { type: 'texte', id: doc.slug + '#texte-1', source: { page: 1, zone: { x: 10, y: 10, l: 100, h: 20 } }, confiance: 'lu', libelle: 'Figure 1 Station model', role: 'legende' };
const lecture = { version: 1, genre: mode === 'genre' ? 'inventaire' : 'lecture', document: { slug: doc.slug, sha256: mode === 'autre' ? 'c'.repeat(64) : doc.sha256 }, elements: [mode === 'invalide' ? { ...texte, role: 'etiquette' } : texte] };
if (mode !== 'sans-fichier') { fs.mkdirSync(require('node:path').dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(lecture)); }
out({ structured_output: { resume: 'lu', questions: mode === 'question' ? ['Que veut dire Figure 1 ?'] : [] } });
`;

const NORME: FixturePage[] = [
  { lines: [{ x: 72, y: 700, t: 'The station model is drawn in Figure 1 on page two.' }] },
  { lines: [{ x: 72, y: 380, t: 'Figure 1 Station model' }], image: { x: 72, y: 400, w: 200, h: 100 } },
  { lines: [{ x: 72, y: 700, t: 'Table 2 Codes' }] },
];
const pagesVides = (n: number): FixturePage[] => Array.from({ length: n }, (_, i) => ({ lines: [{ x: 72, y: 700, t: `Page ${i + 1} of the document` }] }));

function setup(mode = 'ok', pages: FixturePage[] = NORME) {
  const base = tempDir();
  const stubs = stubTools(base, ['magick', 'tesseract', 'claude-fake']);
  const bin = join(stubs, 'claude-fake');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const refs = join(base, 'refs');
  const log = join(base, 'claude.log');
  writeFileSync(log, '');
  const cwd = join(base, 'work');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'cadence.yaml'), `references:\n  dir: ${refs}\n`);
  const env = { RAF_TODAY: '2026-10-24', PATH: `${stubs}:${process.env.PATH}`, XDG_DATA_HOME: join(base, 'xdg'), CADENCE_CLAUDE_BIN: bin, FAKE_LOG: log, FAKE_MODE: mode } as NodeJS.ProcessEnv;
  const pdf = writePdf(base, 'norme.pdf', pages);
  const appels = (): { args: string[]; cwd: string; brief: string }[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { base, refs, env, cwd, pdf, appels };
}

async function analyse(s: ReturnType<typeof setup>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['ref', 'analyse', s.pdf, '--slug', 'norme', ...argv], { cwd: s.cwd, env: s.env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-24T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const lectureOf = (s: ReturnType<typeof setup>): Obj => JSON.parse(readFileSync(join(s.refs, 'norme', 'lectures', 'a.json'), 'utf8'));

describe('agent reference-analyst (agents/reference-analyst.md, L265)', () => {
  it('R1 — l\'agent est livré avec les outils de lecture et d\'écriture, sans sous-agent', () => {
    const agents = readAgents(join(root, 'agents'));
    expect(Object.keys(agents)).toContain('reference-analyst');
    const tools = agents['reference-analyst'].tools ?? [];
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Bash', 'Grep', 'Glob']));
    expect(tools).not.toContain('Agent');
    expect(tools).not.toContain('Edit');
  });

  it('R2 — sa consigne : regarder chaque page puis chaque zone, mesurer par ref measure, citer verbatim, ne jamais deviner, valider par ref check', () => {
    for (const mot of ['cadence ref measure', 'cadence ref check', 'verbatim', 'incertain', 'cause', 'templates/inventaire.json', 'figure', 'silence']) expect(AGENT, mot).toContain(mot);
    expect(AGENT).toMatch(/never guess|never invent/i);
    expect(AGENT).toMatch(/whole page/i);
    expect(AGENT).toMatch(/full resolution/i);
  });

  it('R3 — il n\'écrit ni les jetons ni l\'empreinte à la place du programme, ne lit aucun attendu et n\'écrit que sa lecture', () => {
    expect(AGENT).toMatch(/never write `usage`/i);
    expect(AGENT).toMatch(/expected inventory|attendu/);
    expect(AGENT).toMatch(/only (write )?the reading|write only/i);
    expect(AGENT).toMatch(/launch subagents/i);
  });
});

describe('cadence ref analyse (L265)', () => {
  it('R4 — add d\'abord, puis une seule session de l\'agent reference-analyst, en sonnet par défaut, dans le dossier du document', async () => {
    const s = setup();
    const r = await analyse(s);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(s.refs, 'norme', 'pages', 'page-1.png'))).toBe(true);
    const appels = s.appels();
    expect(appels).toHaveLength(1);
    const { args, cwd } = appels[0]!;
    expect(args[args.indexOf('--agent') + 1]).toBe('reference-analyst');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--json-schema');
    expect(cwd).toBe(join(s.refs, 'norme'));
    expect(args).toContain(join(s.refs, 'norme'));
  });

  it('R5 — --model choisit le modèle de la lecture ; un modèle inconnu est refusé avant tout travail', async () => {
    const s = setup();
    expect((await analyse(s, '--model', 'opus')).code).toBe(0);
    expect(s.appels()[0]!.args[s.appels()[0]!.args.indexOf('--model') + 1]).toBe('opus');
    const t = setup();
    const r = await analyse(t, '--model', 'gpt');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--model');
    expect(t.appels()).toHaveLength(0);
    expect(existsSync(join(t.refs, 'norme'))).toBe(false);
  });

  it('R6 — la consigne nomme le document, ses pages rendues, la lecture à écrire, le modèle d\'inventaire et les commandes de mesure et de validation', async () => {
    const s = setup();
    await analyse(s);
    const brief = s.appels()[0]!.brief;
    const dir = join(s.refs, 'norme');
    expect(brief).toContain('norme');
    for (const n of [1, 2, 3]) expect(brief).toContain(join(dir, 'pages', `page-${n}.png`));
    expect(brief).toContain(join(dir, 'lectures', 'a.json'));
    expect(brief).toContain(join(root, 'templates', 'inventaire.json'));
    expect(brief).toMatch(/bin\/cadence\.js ref measure norme /);
    expect(brief).toMatch(/bin\/cadence\.js ref check .*lectures\/a\.json/);
    expect(brief).toContain(join(s.cwd, 'cadence.yaml'));
  });

  it('R7 — la lecture est une lecture sans le moindre attendu : la consigne ne nomme ni attendu ni corpus', async () => {
    const s = setup();
    await analyse(s);
    expect(s.appels()[0]!.brief).not.toMatch(/attendu|corpus/i);
  });

  it('R8 — le programme pose les jetons de la session dans la lecture, et ref eval en tire les tokens par page', async () => {
    const s = setup();
    const r = await analyse(s);
    expect(lectureOf(s).usage.tokens).toBe(1000);
    expect(r.out).toContain('tokens : 1000 (333 par page, 3 pages lues)');
    const sha = lectureOf(s).document.sha256;
    const attendu: Obj = { ...lectureOf(s), genre: 'inventaire', pages: 3 };
    delete attendu.usage;
    expect(attendu.document.sha256).toBe(sha);
    writeFileSync(join(s.base, 'attendu.json'), JSON.stringify(attendu));
    const out: string[] = [];
    const code = await run(['ref', 'eval', join(s.base, 'attendu.json'), join(s.refs, 'norme', 'lectures', 'a.json')], { cwd: s.cwd, env: s.env, out: (l) => out.push(l), err: () => undefined, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('tokens par page : 333');
  });

  it('R9 — le plafond d\'une lecture est de 20 pages : 21 pages rendues sont refusées avant toute session, 20 passent', async () => {
    expect(LECTURE_PAGES_MAX).toBe(20);
    const trop = setup('ok', pagesVides(21));
    const r = await analyse(trop);
    expect(r.code).toBe(2);
    expect(r.err).toContain('21 pages rendues');
    expect(r.err).toContain('plafond');
    expect(r.err).toContain('--sections');
    expect(trop.appels()).toHaveLength(0);
    const pile = setup('ok', pagesVides(20));
    expect((await analyse(pile)).code).toBe(0);
    expect(pile.appels()).toHaveLength(1);
  });

  it('R10 — le plafond est dit dans la sortie, à côté des pages lues', async () => {
    const s = setup();
    const r = await analyse(s);
    expect(r.out).toContain('3 pages lues (plafond d\'une lecture : 20)');
  });

  it('R11 — aucune page rendue (grand document sans --sections) : refus, aucune session', async () => {
    const s = setup('ok', pagesVides(31));
    const r = await analyse(s);
    expect(r.code).toBe(2);
    expect(r.err).toContain('aucune page rendue');
    expect(r.err).toContain('--sections');
    expect(s.appels()).toHaveLength(0);
  });

  it('R12 — une lecture que ref check refuse rend le code 1 avec les écarts sur la sortie standard, et ne reçoit pas de jetons', async () => {
    const s = setup('invalide');
    const r = await analyse(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ elements\[0\]\.role/);
    expect(r.out).toContain('1 écart(s)');
    expect(lectureOf(s).usage).toBeUndefined();
  });

  it('R13 — une lecture d\'un autre document (empreinte) ou d\'un autre genre est refusée, jamais mesurée', async () => {
    const autre = await analyse(setup('autre'));
    expect(autre.code).toBe(1);
    expect(autre.out).toContain('empreinte');
    const genre = await analyse(setup('genre'));
    expect(genre.code).toBe(1);
    expect(genre.out).toContain('genre');
  });

  it('R14 — une session qui n\'a écrit aucune lecture est un refus nommé (code 1)', async () => {
    const r = await analyse(setup('sans-fichier'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('lectures/a.json');
    expect(r.out).toContain('aucune lecture');
  });

  it('R14 — la lecture d\'un passage précédent ne passe jamais pour celle du suivant', async () => {
    const s = setup();
    expect((await analyse(s)).code).toBe(0);
    s.env.FAKE_MODE = 'sans-fichier';
    const r = await analyse(s);
    expect(r.code).toBe(1);
    expect(r.out).toContain('aucune lecture');
  });

  it('R15 — quota atteint : code 3 et le message du quota, sans lecture ; session en échec : code 2 et la cause', async () => {
    const q = setup('quota');
    const rq = await analyse(q);
    expect(rq.code).toBe(3);
    expect(rq.err).toContain('quota');
    expect(rq.err).toContain('usage limit reached');
    expect(existsSync(join(q.refs, 'norme', 'lectures', 'a.json'))).toBe(false);
    const c = setup('crash');
    const rc = await analyse(c);
    expect(rc.code).toBe(2);
    expect(rc.err).toContain('code 1');
  });

  it('R16 — les questions de l\'agent sont reprises dans la sortie, une par ligne', async () => {
    const r = await analyse(setup('question'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('question : Que veut dire Figure 1 ?');
  });

  it('R17 — la sortie résume la lecture : éléments par confiance, et le chemin du fichier', async () => {
    const s = setup();
    const r = await analyse(s);
    expect(r.out).toContain('lecture unique (sonnet)');
    expect(r.out).toContain('éléments : 1 (lu : 1)');
    expect(r.out).toContain(join(s.refs, 'norme', 'lectures', 'a.json'));
  });

  it('R18 — un appel sans document, ou avec deux, rend l\'usage (code 2)', async () => {
    const s = setup();
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['ref', 'analyse'], { cwd: s.cwd, env: s.env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date() });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('cadence ref analyse <document.pdf>');
    expect(s.appels()).toHaveLength(0);
  });
});
