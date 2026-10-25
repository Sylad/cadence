import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { checkInventaire } from '../src/ref/check.js';
import { decodePng } from '../src/ref/png.js';
import { tempDir } from './helpers.js';
import { stubTools, writePdf, type FixturePage } from './ref-fixture.js';

const root = join(import.meta.dirname, '..');
type Obj = Record<string, any>;

/**
 * Faux `claude` (CADENCE_CLAUDE_BIN) pour la double lecture : journalise chaque appel (FAKE_LOG), puis selon l'agent
 *  - reference-analyst : écrit la lecture que le brief nomme (a.json ou b.json) avec les éléments de FAKE_A ou FAKE_B (`SLUG` est remplacé par le slug du document) ;
 *  - reference-verifier : rend les décisions de FAKE_DECISIONS.
 * Chaque session rend 100 + 400 + 500 jetons comptés.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const brief = args[args.indexOf('-p') + 1];
const agent = args[args.indexOf('--agent') + 1];
const model = args[args.indexOf('--model') + 1];
const m = /(\\S+\\/lectures\\/([ab])\\.json)/.exec(brief);
// l'état au démarrage de la session : sa propre lecture et l'inventaire (ceux d'un passage précédent doivent avoir disparu)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ agent, model, args, cwd: process.cwd(), brief, propre: m ? fs.existsSync(m[1]) : null, inventaire: fs.existsSync(path.join(process.cwd(), 'inventaire.json')) }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-' + agent + '-' + model, num_turns: 4, duration_ms: 10, result: '', usage: { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 9000, output_tokens: 500 }, ...o }));
const mode = process.env.FAKE_MODE || 'ok';
if (agent === 'reference-verifier') {
  if (mode === 'quota-regard') { out({ is_error: true, subtype: 'error', result: 'Claude usage limit reached | resets at 5pm' }); process.exit(0); }
  out({ structured_output: { decisions: JSON.parse(process.env.FAKE_DECISIONS || '[]'), questions: [] } });
  process.exit(0);
}
const file = m[1];
const nom = m[2];
if (mode === 'quota-' + nom) { out({ is_error: true, subtype: 'error', result: 'Claude usage limit reached | resets at 5pm' }); process.exit(0); }
const doc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'document.json'), 'utf8'));
const raw = process.env['FAKE_' + nom.toUpperCase()].split('SLUG').join(doc.slug);
const elements = JSON.parse(raw);
const lecture = { version: 1, genre: mode === 'invalide-' + nom ? 'inventaire' : 'lecture', document: { slug: doc.slug, sha256: doc.sha256 }, elements };
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(lecture));
out({ structured_output: { resume: 'lu', questions: mode === 'question' ? ['Que veut dire Figure 1 ?'] : [] } });
`;

const NORME: FixturePage[] = [
  { lines: [{ x: 72, y: 700, t: 'The station model is drawn in Figure 1 on page two.' }] },
  { lines: [{ x: 72, y: 380, t: 'Figure 1 Station model' }], image: { x: 72, y: 400, w: 200, h: 100 } },
  { lines: [{ x: 72, y: 700, t: 'Table 2 Codes' }] },
];

const texte = (n: number, libelle: string, x: number, o: Obj = {}): Obj => ({ type: 'texte', id: `SLUG#texte-${n}`, confiance: 'lu', source: { page: 1, zone: { x, y: 100, l: 200, h: 40 } }, libelle, role: 'titre', ...o });
const silence = (n: number, question: string): Obj => ({ type: 'silence', id: `SLUG#silence-${n}`, confiance: 'incertain', source: { page: 1 }, cause: 'non montré', question });

/** Lecture A : quatre textes concordants, « 120 KT » (divergent), le silence « Que voit-on en erreur ? ». */
const COMMUN = [texte(1, 'Layers', 100), texte(2, 'Wind', 400), texte(3, 'Waves', 700), texte(4, 'Tides', 1000)];

function setup(o: { a?: Obj[]; b?: Obj[]; decisions?: Obj[]; mode?: string; pages?: FixturePage[] } = {}) {
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
  const env = {
    RAF_TODAY: '2026-10-25',
    PATH: `${stubs}:${process.env.PATH}`,
    XDG_DATA_HOME: join(base, 'xdg'),
    CADENCE_CLAUDE_BIN: bin,
    CLAUDE_CONFIG_DIR: join(base, 'claude-home'),
    FAKE_LOG: log,
    FAKE_MODE: o.mode ?? 'ok',
    FAKE_A: JSON.stringify(o.a ?? COMMUN),
    FAKE_B: JSON.stringify(o.b ?? COMMUN),
    FAKE_DECISIONS: JSON.stringify(o.decisions ?? []),
  } as NodeJS.ProcessEnv;
  const pdf = writePdf(base, 'norme.pdf', o.pages ?? NORME);
  const appels = (): { agent: string; model: string; args: string[]; cwd: string; brief: string; propre: boolean | null; inventaire: boolean }[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { base, refs, env, cwd, pdf, appels, dir: join(refs, 'norme') };
}

async function analyse(s: ReturnType<typeof setup>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['ref', 'analyse', s.pdf, '--slug', 'norme', ...argv], { cwd: s.cwd, env: s.env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-25T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const lire = (file: string): Obj => JSON.parse(readFileSync(file, 'utf8'));
const analystes = (s: ReturnType<typeof setup>) => s.appels().filter((a) => a.agent === 'reference-analyst');
const verifiers = (s: ReturnType<typeof setup>) => s.appels().filter((a) => a.agent === 'reference-verifier');

describe('agents de la double lecture (L266)', () => {
  const agents = readAgents(join(root, 'agents'));
  const analyst = readFileSync(join(root, 'agents', 'reference-analyst.md'), 'utf8');
  const verifier = readFileSync(join(root, 'agents', 'reference-verifier.md'), 'utf8');

  it('R1 — le lecteur ne lit aucune autre lecture du dossier lectures/ : une lecture faite la réponse en main ne mesure rien', () => {
    expect(analyst).toMatch(/never (open|read)[^.]*another file of `lectures\//i);
  });

  it('R2 — le troisième regard : un agent en lecture seule (Read, Bash pour mesurer), sans écriture ni sous-agent, qui ne voit que les éléments et leurs découpes', () => {
    const tools = agents['reference-verifier']?.tools ?? [];
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Bash']));
    for (const interdit of ['Write', 'Edit', 'Agent']) expect(tools).not.toContain(interdit);
    for (const mot of ['confirme', 'ecarte', 'raison', 'cadence ref measure', 'crop']) expect(verifier, mot).toContain(mot);
    expect(verifier).toMatch(/never guess/i);
    expect(verifier).toMatch(/only the elements/i);
  });
});

describe('cadence ref analyse en double lecture (L266)', () => {
  it('R3 — deux sessions du reference-analyst, A en sonnet et B en opus par défaut, chacune dans le dossier du document, lectures/a.json et lectures/b.json', async () => {
    const s = setup();
    const r = await analyse(s);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const ap = analystes(s);
    expect(ap).toHaveLength(2);
    expect(ap.map((a) => a.model).sort()).toEqual(['opus', 'sonnet']);
    for (const a of ap) {
      expect(a.cwd).toBe(s.dir);
      expect(a.args).toContain(s.dir);
    }
    expect(existsSync(join(s.dir, 'lectures', 'a.json'))).toBe(true);
    expect(existsSync(join(s.dir, 'lectures', 'b.json'))).toBe(true);
  });

  it('R4 — --model choisit la lecture A, --model-b la lecture B ; un modèle inconnu est refusé avant tout travail', async () => {
    const s = setup();
    expect((await analyse(s, '--model', 'haiku', '--model-b', 'sonnet')).code).toBe(0);
    const parNom = (n: string) => analystes(s).find((a) => new RegExp(`lectures/${n}\\.json`).test(a.brief))!.model;
    expect([parNom('a'), parNom('b')]).toEqual(['haiku', 'sonnet']);
    for (const argv of [['--model-b', 'gpt'], ['--model', 'gpt']]) {
      const t = setup();
      const r = await analyse(t, ...argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain(argv[0]!);
      expect(t.appels()).toHaveLength(0);
      expect(existsSync(t.dir)).toBe(false);
    }
  });

  it('R5 — les deux lectures sont indépendantes : même consigne (au fichier près), jamais le nom de l\'autre lecture, et la défense de lire le dossier lectures/', async () => {
    const s = setup();
    await analyse(s);
    const [briefA, briefB] = ['a', 'b'].map((n) => analystes(s).find((a) => new RegExp(`lectures/${n}\\.json`).test(a.brief))!.brief);
    expect(briefA).not.toMatch(/lectures\/b\.json/);
    expect(briefB).not.toMatch(/lectures\/a\.json/);
    expect(briefA.split('lectures/a.json').join('lectures/X.json')).toBe(briefB.split('lectures/b.json').join('lectures/X.json'));
    expect(briefA).toMatch(/aucun autre fichier de .*lectures/);
    expect(briefA).not.toMatch(/attendu|corpus/i);
  });

  it('R6 — les lectures d\'un passage précédent (a.json, b.json, inventaire.json) sont supprimées avant les sessions : aucune ne passe pour celle de ce passage', async () => {
    const s = setup();
    expect((await analyse(s)).code).toBe(0);
    expect((await analyse(s)).code).toBe(0);
    const seconde = analystes(s).slice(-2);
    expect(seconde).toHaveLength(2);
    for (const a of seconde) {
      expect(a.propre).toBe(false);
      expect(a.inventaire).toBe(false);
    }
  });

  it('R7 — l\'inventaire réconcilié est écrit dans le dossier du document, valide pour ref check : concordants lus, ids renumérotés', async () => {
    const s = setup();
    const r = await analyse(s);
    expect(r.code).toBe(0);
    const inv = lire(join(s.dir, 'inventaire.json'));
    expect(inv.genre).toBe('inventaire');
    expect(checkInventaire(inv)).toEqual([]);
    expect(inv.elements.map((e: Obj) => [e.id, e.libelle, e.confiance])).toEqual([['norme#texte-1', 'Layers', 'lu'], ['norme#texte-2', 'Wind', 'lu'], ['norme#texte-3', 'Waves', 'lu'], ['norme#texte-4', 'Tides', 'lu']]);
    expect(r.out).toContain('norme : double lecture (A sonnet, B opus) — 3 pages lues');
    expect(r.out).toContain(`inventaire : ${join(s.dir, 'inventaire.json')}`);
    expect(r.out).toContain('réconciliation : concordants 4 · divergents 0 · seuls 0 · silences 0');
  });

  it('R8 — sans élément d\'une seule lecture, aucun troisième regard n\'est lancé', async () => {
    const s = setup();
    await analyse(s);
    expect(verifiers(s)).toHaveLength(0);
    expect(s.appels()).toHaveLength(2);
  });

  it('R9 — un élément d\'une seule lecture part au troisième regard : une session reference-verifier, sa consigne ne porte que ces éléments et leur découpe, jamais le reste', async () => {
    const s = setup({ b: [...COMMUN, texte(5, 'Seul', 1300, { source: { page: 2, zone: { x: 1300, y: 100, l: 200, h: 40 } } })], decisions: [{ numero: 1, verdict: 'confirme', raison: 'écrit sur la découpe' }] });
    const r = await analyse(s, '--seuil', '50');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const v = verifiers(s);
    expect(v).toHaveLength(1);
    expect(v[0]!.model).toBe('sonnet');
    expect(v[0]!.cwd).toBe(s.dir);
    expect(v[0]!.brief).toContain('Seul');
    for (const l of ['Layers', 'Wind', 'Waves', 'Tides']) expect(v[0]!.brief).not.toContain(l);
    expect(v[0]!.brief).toContain(join(s.dir, 'pages', 'page-2.png'));
    const crop = /(\S+crops\/\S+\.png)/.exec(v[0]!.brief)![1]!;
    expect(existsSync(crop)).toBe(true);
    const png = decodePng(readFileSync(crop), 'découpe');
    // la zone (200 × 40) et une marge de 24 px de chaque côté
    expect([png.width, png.height]).toEqual([248, 88]);
  });

  it('R10 — le troisième regard : confirmé passe lu, écarté disparaît, sans réponse reste incertain (jamais un lu par défaut) ; la raison est gardée', async () => {
    const seuls = [texte(5, 'Confirmé', 1300), texte(6, 'Écarté', 1600), texte(7, 'Muet', 1900)];
    const s = setup({ b: [...COMMUN, ...seuls], decisions: [{ numero: 1, verdict: 'confirme', raison: 'écrit tel quel' }, { numero: 2, verdict: 'ecarte', raison: 'rien de tel dans la découpe' }, { numero: 9, verdict: 'confirme', raison: 'numéro inconnu' }] });
    const r = await analyse(s, '--seuil', '50');
    expect(r.code).toBe(0);
    const inv = lire(join(s.dir, 'inventaire.json'));
    const par = (l: string) => inv.elements.find((e: Obj) => e.libelle === l);
    expect(par('Confirmé').confiance).toBe('lu');
    expect(par('Écarté')).toBeUndefined();
    expect(par('Muet').confiance).toBe('incertain');
    expect(par('Muet').cause).toMatch(/troisième regard sans réponse/);
    expect(inv.reconciliation.regard).toEqual([
      { lecture: 'b', id: 'norme#texte-5', verdict: 'confirme', raison: 'écrit tel quel' },
      { lecture: 'b', id: 'norme#texte-6', verdict: 'ecarte', raison: 'rien de tel dans la découpe' },
    ]);
    expect(r.out).toContain('troisième regard (sonnet) : 1 confirmé, 1 écarté, 1 sans réponse');
  });

  it('R11 — un verdict sans raison, ou un verdict inconnu, vaut une absence de réponse', async () => {
    const s = setup({ b: [...COMMUN, texte(5, 'SansRaison', 1300), texte(6, 'Bizarre', 1600)], decisions: [{ numero: 1, verdict: 'confirme', raison: ' ' }, { numero: 2, verdict: 'peut-etre', raison: 'hésite' }] });
    expect((await analyse(s, '--seuil', '50')).code).toBe(0);
    const inv = lire(join(s.dir, 'inventaire.json'));
    expect(inv.elements.filter((e: Obj) => e.confiance === 'incertain').map((e: Obj) => e.libelle)).toEqual(['SansRaison', 'Bizarre']);
  });

  it('R12 — un élément dont la page n\'a pas été rendue part sans découpe, la consigne le dit', async () => {
    const s = setup({ b: [...COMMUN, texte(5, 'Loin', 1300, { source: { page: 9, zone: { x: 1300, y: 100, l: 200, h: 40 } } })], decisions: [{ numero: 1, verdict: 'ecarte', raison: 'page introuvable' }] });
    expect((await analyse(s, '--seuil', '50')).code).toBe(0);
    expect(verifiers(s)[0]!.brief).toMatch(/pas de découpe/);
  });

  it('R13 — un divergent est incertain avec les deux versions et ne part pas au troisième regard', async () => {
    const s = setup({ a: [...COMMUN, texte(5, '120 KT', 1300)], b: [...COMMUN, texte(5, '120 kt', 1300)] });
    const r = await analyse(s);
    expect(r.code).toBe(0);
    expect(verifiers(s)).toHaveLength(0);
    const e = lire(join(s.dir, 'inventaire.json')).elements.find((x: Obj) => x.confiance === 'incertain');
    expect(e.cause).toContain('120 KT');
    expect(e.cause).toContain('120 kt');
    expect(r.out).toContain('divergents 1');
  });

  it('R14 — plus de 30 % d\'éléments non appariés : code 1, la question au lead, les deux lectures gardées, pas d\'inventaire ni de troisième regard', async () => {
    const s = setup({ a: [texte(1, 'Layers', 100)], b: [texte(1, 'Autre', 100, { source: { page: 3, zone: { x: 100, y: 100, l: 200, h: 40 } } })] });
    const r = await analyse(s);
    expect(r.code).toBe(1);
    expect(r.out).toContain('question au lead');
    expect(existsSync(join(s.dir, 'lectures', 'a.json'))).toBe(true);
    expect(existsSync(join(s.dir, 'lectures', 'b.json'))).toBe(true);
    expect(existsSync(join(s.dir, 'inventaire.json'))).toBe(false);
    expect(verifiers(s)).toHaveLength(0);
  });

  it('R15 — les jetons : chaque lecture porte son usage, l\'inventaire le total des trois sessions et le détail ; ref eval en tire les tokens par page', async () => {
    const s = setup({ b: [...COMMUN, texte(5, 'Seul', 1300)], decisions: [{ numero: 1, verdict: 'confirme', raison: 'lu' }] });
    const r = await analyse(s, '--seuil', '50');
    expect(lire(join(s.dir, 'lectures', 'a.json')).usage).toEqual({ tokens: 1000, modele: 'sonnet', session: 's-reference-analyst-sonnet' });
    expect(lire(join(s.dir, 'lectures', 'b.json')).usage).toEqual({ tokens: 1000, modele: 'opus', session: 's-reference-analyst-opus' });
    const inv = lire(join(s.dir, 'inventaire.json'));
    expect(inv.usage.tokens).toBe(3000);
    expect(inv.usage.lectures).toEqual({ a: { tokens: 1000, modele: 'sonnet' }, b: { tokens: 1000, modele: 'opus' }, regard: { tokens: 1000, modele: 'sonnet' } });
    expect(r.out).toContain('tokens : 3000 (1000 par page, 3 pages lues) — A : 1000, B : 1000, troisième regard : 1000');
    const attendu: Obj = { ...inv, pages: 3 };
    delete attendu.usage;
    delete attendu.reconciliation;
    writeFileSync(join(s.base, 'attendu.json'), JSON.stringify(attendu));
    const out: string[] = [];
    expect(await run(['ref', 'eval', join(s.base, 'attendu.json'), join(s.dir, 'inventaire.json')], { cwd: s.cwd, env: s.env, out: (l) => out.push(l), err: () => undefined, now: () => new Date() })).toBe(0);
    expect(out.join('\n')).toContain('tokens par page : 1000');
  });

  it('R16 — quota sur l\'une des deux lectures, ou sur le troisième regard : code 3, rien d\'écrit comme inventaire', async () => {
    for (const mode of ['quota-a', 'quota-b']) {
      const s = setup({ mode });
      const r = await analyse(s);
      expect(r.code, mode).toBe(3);
      expect(r.err).toContain('quota atteint');
      expect(existsSync(join(s.dir, 'inventaire.json'))).toBe(false);
    }
    const t = setup({ mode: 'quota-regard', b: [...COMMUN, texte(5, 'Seul', 1300)] });
    const r = await analyse(t, '--seuil', '50');
    expect(r.code).toBe(3);
    expect(r.err).toContain('troisième regard');
    expect(existsSync(join(t.dir, 'inventaire.json'))).toBe(false);
  });

  it('R17 — une lecture refusée par le programme (mauvais genre) : code 1, la lecture nommée, pas de réconciliation', async () => {
    const s = setup({ mode: 'invalide-b' });
    const r = await analyse(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ lecture B : genre/);
    expect(r.out).not.toMatch(/lecture A :/);
    expect(existsSync(join(s.dir, 'inventaire.json'))).toBe(false);
  });

  it('R18 — --unique garde la lecture unique de L265 : une session, lectures/a.json, pas d\'inventaire ; --model-b et --seuil n\'y ont pas de sens', async () => {
    const s = setup();
    const r = await analyse(s, '--unique');
    expect(r.code).toBe(0);
    expect(s.appels()).toHaveLength(1);
    expect(r.out).toContain('norme : lecture unique (sonnet)');
    expect(existsSync(join(s.dir, 'lectures', 'b.json'))).toBe(false);
    expect(existsSync(join(s.dir, 'inventaire.json'))).toBe(false);
    for (const opt of ['--model-b', '--seuil']) {
      const t = setup();
      const x = await analyse(t, '--unique', opt, opt === '--seuil' ? '20' : 'opus');
      expect(x.code).toBe(2);
      expect(x.err).toContain(opt);
      expect(t.appels()).toHaveLength(0);
    }
  });

  it('R19 — le plafond de 20 pages vaut pour chaque lecture : refusé avant toute session', async () => {
    const trop = setup({ pages: Array.from({ length: 21 }, (_, i) => ({ lines: [{ x: 72, y: 700, t: `Page ${i + 1} of the document` }] })) });
    const r = await analyse(trop);
    expect(r.code).toBe(2);
    expect(r.err).toContain('plafond');
    expect(trop.appels()).toHaveLength(0);
  });

  it('R20 — les questions des deux lectures sont rendues une fois chacune, et seuls les crops du troisième regard sont écrits dans crops/', async () => {
    const s = setup({ mode: 'question' });
    const r = await analyse(s);
    expect(r.out.match(/question : Que veut dire Figure 1 \?/g)).toHaveLength(1);
    expect(existsSync(join(s.dir, 'crops')) ? readdirSync(join(s.dir, 'crops')) : []).toEqual([]);
  });
});
