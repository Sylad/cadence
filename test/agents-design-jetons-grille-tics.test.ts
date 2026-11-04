import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { checkShape, REVIEW_SCHEMA } from '../src/orchestrate/schemas.js';
import { AGENTS_DIR, installAgents } from '../src/skills.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { changelogSectionOf } from './changelog-section.js';
import { tempDir } from './helpers.js';

// L513 (spec agents-design-jetons-grille-tics) : jetons on-* et contraste (spec-writer), grille avant livraison et tics d'IA (ux-reviewer).
const root = join(__dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const empreinte = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const entre = (t: string, a: string, b?: string) => t.slice(t.indexOf(a), b ? t.indexOf(b) : undefined);
const plat = (s: string) => s.replace(/\s+/g, ' ');

const ux = read('agents/ux-reviewer.md');
const writer = read('agents/spec-writer.md');
const grille = entre(ux, '## Delivery grid');
const courte = entre(ux, '## Short reply', '## Delivery grid');
const tools = (t: string) => t.match(/^tools: .*$/m)![0];

const lots = [{ title: 'Un écran', screen: 'page' as const }];
const screen = { visible: true, screen: 'page' as const };
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const brief = async (kind: 'maquette' | 'spec' | 'ux') => {
  const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], ux: [ok], review: [ok] } });
  await runLot(h.lot('L1', screen, { maquette: true, ux: { url: 'http://localhost:4200' } }));
  return h.calls.find((c) => c.kind === kind)!.brief;
};

describe('R1/R2/R3 — jetons sémantiques, on-*, rampe de la charte', () => {
  it('R1 — spec-writer.md exige un jeton sémantique et son on-* pour chaque couleur ajoutée', () => {
    const t = plat(writer);
    expect(t).toMatch(/semantic token named by its role/);
    expect(t).toContain('on-<role>');
    expect(t).toMatch(/colour added without its `on-\*` token is a defect of the spec/);
  });
  it('R1 — le brief spec.md rendu porte la même consigne', async () => {
    const b = plat(await brief('spec'));
    expect(b).toContain('semantic token named by its role');
    expect(b).toContain('on-<role>');
  });
  it('R2 — spec-writer.md demande une rampe tirée de la couleur de marque de la charte', () => {
    expect(plat(writer)).toMatch(/ramp drawn from the charter's brand colour \(same hue, stepped lightness\)/);
  });
  it('R2 — spec-writer.md ne nomme aucune palette externe', () => {
    expect(plat(writer)).toMatch(/imports no external palette/);
    for (const s of ['Tailwind', 'Material', 'Radix', 'Bootstrap', 'Open Color']) expect(writer, s).not.toContain(s);
  });
  it('R3 — spec-writer.md garde « reuse what exists » et interdit un jeton en double', () => {
    expect(writer).toContain('reuse what exists');
    expect(plat(writer)).toMatch(/role already covered by a token of the charter keeps that token[^.]*no duplicate token/);
  });
  it('R3 — un jeton existant n’apparaît pas dans la liste des jetons créés de contraste.md', () => {
    const t = plat(writer);
    expect(t).toMatch(/`contraste\.md` has two lists: the tokens created, and the existing pairs measured/);
    expect(t).toMatch(/an existing token appears only in the second/);
  });
});

describe('R4/R5 — rapport de contraste', () => {
  it('R4 — spec-writer.md exige contraste.md, une ligne par paire, seuil 4,5:1', () => {
    const t = plat(writer);
    expect(t).toContain('contraste.md');
    expect(t).toMatch(/one line per token \/ on-token pair[^.]*both values[^.]*ratio[^.]*WCAG 2\.2[^.]*relative luminance[^.]*`ok` or `non`/);
    expect(t).toMatch(/at least 4\.5:1/);
    expect(t).toMatch(/change the step of the ramp, never the text size/);
  });
  it('R4 — le brief spec.md demande de committer contraste.md avec la fiche', async () => {
    const b = plat(await brief('spec'));
    expect(b).toMatch(/contraste\.md/);
    expect(b).toMatch(/the sheet, the mockup, the captures and `contraste\.md` together/);
  });
  it('R4 — une paire à 4,49:1 est nommée non conforme par la consigne, une paire à 4,5:1 conforme', () => {
    const t = plat(writer);
    expect(t).toMatch(/4\.49:1 is `non`/);
    expect(t).toMatch(/4\.5:1 is `ok`/);
  });
  it('R5 — spec-writer.md interdit d’inventer une rampe sans couleur de marque', () => {
    expect(plat(writer)).toMatch(/no CSS variable and no brand colour[^.]*invent no ramp/);
  });
  it('R5 — spec-writer.md demande de mesurer les valeurs existantes dans ce cas', () => {
    const t = plat(writer);
    expect(t).toMatch(/measure the existing values in `contraste\.md`/);
    expect(t).toMatch(/write the absence of a coloured charter in the sheet/);
  });
});

describe('R6/R7 — grille avant livraison', () => {
  it('R6 — ux-reviewer.md contient les cinq points de la grille et les quatre largeurs', () => {
    expect(grille.length).toBeGreaterThan(0);
    for (const p of ['visible focus', 'prefers-reduced-motion', 'cursor: pointer', 'no emoji used as an icon', 'no horizontal scroll', '375', '768', '1024', '1440']) expect(grille, p).toContain(p);
  });
  it('R6 — ux-reviewer.md range une largeur non rendue dans nonVerifie', () => {
    expect(plat(grille)).toMatch(/width that cannot be rendered goes in `nonVerifie`, not ticked/);
  });
  it('R6 — la section Delivery grid est placée après Short reply et la réponse courte ne reprend pas la liste', () => {
    expect(ux.indexOf('## Delivery grid')).toBeGreaterThan(ux.indexOf('## Short reply'));
    expect(ux.indexOf('## Delivery grid')).toBe(ux.lastIndexOf('\n## ') + 1);
    for (const s of ['prefers-reduced-motion', 'cursor', 'emoji', '768']) expect(courte, s).not.toContain(s);
    expect(plat(grille)).toMatch(/applies in every case, with or without a `Report file:` line/);
    expect(plat(grille)).toMatch(/checklist of the report file/);
  });
  it('R6 — sans ligne Report file (étape ux orchestrée), la grille et la ligne des tics vont dans nonVerifie et le verdict du rapport structuré, schéma inchangé', async () => {
    const b = await brief('ux');
    expect(b).not.toContain('Report file:');
    expect(b).toContain('structured output');
    const g = plat(grille);
    expect(g).toMatch(/Without a `Report file:` line \(the orchestrated `ux` step\)/);
    expect(g).toMatch(/a point that could not be checked goes in `nonVerifie`/);
    expect(g).toMatch(/the `verdict` line ends with the tally of the grid and the tics line/);
    expect(g).toMatch(/grille 5\/5 — tics d’IA : 0 constat/);
    expect(g).toMatch(/the structured report has no checklist and its schema is unchanged/);
  });
  it('R6 — un focus non visible reste classé selon l’échelle existante, sans nouvelle gravité', () => {
    expect(plat(grille)).toMatch(/blocking \/ major \/ minor scale of the Method section, no severity of its own/);
    expect(entre(ux, '## Method', '## Output')).toContain('*major* (slows or misleads)');
  });
  it('R7 — la section Mockup mode et la section Conformity mode d’ux-reviewer.md n’ont pas changé', () => {
    expect(empreinte(entre(ux, '## Mockup mode', '## Conformity mode'))).toBe('07ff921fd654863b');
    expect(empreinte(entre(ux, '## Conformity mode', '## Method'))).toBe('0e678bf38c96081f');
  });
  it('R7 — le brief maquette rendu cite toujours 1440 px et 390 px et non 375', async () => {
    const b = await brief('maquette');
    expect(b).toContain('1440 px');
    expect(b).toContain('390 px');
    expect(b).not.toContain('375');
  });
  it('R7 — les empreintes de Inputs, Conformity mode, Method et Output d’ux-reviewer.md sont celles de L448 (aucune mise à jour)', () => {
    expect(empreinte(entre(ux, '## Inputs', '## Mockup mode'))).toBe('1b95a900c30a9113');
    expect(empreinte(entre(ux, '## Conformity mode', '## Method'))).toBe('0e678bf38c96081f');
    expect(empreinte(entre(ux, '## Method', '## Output'))).toBe('f6d00d8463947ffa');
    expect(empreinte(entre(ux, '## Output', '\n## Short reply'))).toBe('3f3791ca62eb6631');
  });
  it('R7 — templates/orchestrate/ux.md garde l’empreinte febe94677a4b9be7', () => {
    expect(empreinte(read('templates/orchestrate/ux.md'))).toBe('febe94677a4b9be7');
  });
  it('R7 — la section Delivery grid est absente des cinq sections empreintées', () => {
    const avant = ux.slice(0, ux.indexOf('## Delivery grid'));
    for (const s of ['## Inputs', '## Mockup mode', '## Conformity mode', '## Method', '## Output']) {
      const fin = ['## Inputs', '## Mockup mode', '## Conformity mode', '## Method', '## Output', '## Short reply'];
      const section = entre(avant, s, fin[fin.indexOf(s) + 1]);
      for (const m of ['Delivery grid', 'prefers-reduced-motion', 'detect.mjs', 'AI tic']) expect(section, `${s} : ${m}`).not.toContain(m);
    }
    expect(plat(grille)).toMatch(/does not apply in mockup mode or conformity mode/);
  });
});

describe('R8/R9/R10 — tics d’IA', () => {
  const regles = grille.split('\n').filter((l) => /^- `tic-/.test(l));
  it('R8 — ux-reviewer.md liste les règles de tics reprises, une par ligne', () => {
    expect(regles.map((l) => l.match(/^- `(tic-[a-z-]+)`/)![1]).sort()).toEqual(
      ['tic-dark-glow', 'tic-gradient-text', 'tic-marketing-buzzword', 'tic-nested-cards', 'tic-overused-font', 'tic-purple-triplet', 'tic-unmodified-shadcn-tokens'],
    );
    expect(new Set(regles.map((l) => l.match(/^- `(tic-[a-z-]+)`/)![1])).size).toBe(regles.length);
    expect(plat(grille)).toMatch(/static check: apply these rules while reading the diff/);
  });
  it('R8 — ux-reviewer.md n’appelle pas detect.mjs', () => {
    expect(plat(grille)).toMatch(/never run `detect\.mjs`|does not run `detect\.mjs`/);
    expect(ux).not.toMatch(/node [^\n]*detect\.mjs|npx [^\n]*detect|import [^\n]*detect\.mjs/);
  });
  it('R8 — le front matter tools d’ux-reviewer est identique à celui d’avant', () => {
    expect(tools(ux)).toBe('tools: Read, Grep, Glob, Bash, mcp__playwright, mcp__plugin_playwright_playwright');
  });
  it('R9 — ux-reviewer.md demande des constats T1, T2… avec fichier, ligne et règle', () => {
    expect(plat(grille)).toMatch(/numbered finding T1, T2[^.]*file, line, named rule and severity/);
  });
  it('R9 — ux-reviewer.md demande « tics d’IA : 0 constat » à défaut de tic', () => {
    expect(grille).toContain('tics d’IA : 0 constat');
    expect(grille).toContain('non applicable');
  });
  it('R9 — ux-reviewer.md classe un tic sans effet sur la tâche en mineur', () => {
    expect(plat(grille)).toMatch(/tic with no effect on the task or on legibility is minor/);
  });
  it('R9 — ux-reviewer.md renvoie un tic nuisant à la lisibilité à l’échelle existante, sans gravité propre', () => {
    expect(plat(grille)).toMatch(/tic that harms legibility or slows the user follows the existing scale[^.]*no severity of its own/);
  });
  it('R10 — ux-reviewer.md excepte les choix de la charte du contrôle des tics', () => {
    expect(plat(grille)).toMatch(/tic that is a choice of the product's charter is not a finding: the charter wins over the rules/);
  });
});

describe('R11/R12 — pas de catalogue de styles, attribution', () => {
  it('R11 — spec-writer.md et ux-reviewer.md interdisent un catalogue de styles génériques sur une app à charte', () => {
    for (const t of [writer, grille]) expect(plat(t)).toMatch(/never (propose|proposes?), draws? or blames? a (generic )?style from a catalogue/);
    for (const t of [writer, grille]) expect(plat(t)).toMatch(/no charter[^.]*follow the existing values and say so/);
  });
  it('R11 — aucun des deux agents ne liste de noms de styles (glassmorphism, brutalisme…)', () => {
    for (const s of ['glassmorphism', 'brutalis', 'neumorphism', 'neomorphism', 'skeuomorph', 'claymorphism', 'bento', 'aurora', 'cyberpunk', 'retro-futur']) {
      expect(writer.toLowerCase(), s).not.toContain(s);
      expect(ux.toLowerCase(), s).not.toContain(s);
    }
  });
  it('R12 — ux-reviewer.md contient « detect.mjs », « Apache-2.0 » et « NOTICE » auprès des règles', () => {
    const t = plat(grille);
    for (const s of ['detect.mjs', 'Apache-2.0', 'NOTICE']) expect(t, s).toContain(s);
    expect(grille.indexOf('NOTICE')).toBeLessThan(grille.indexOf('- `tic-'));
  });
  it('R12 — NOTICE existe, nomme l’original et sa licence, et est listé dans files de package.json', () => {
    const notice = read('NOTICE');
    expect(notice).toContain('detect.mjs');
    expect(notice).toContain('Apache-2.0');
    expect(notice).toMatch(/reworded|reformulées/);
    expect(JSON.parse(read('package.json')).files).toContain('NOTICE');
  });
  it('R12 — les sept règles viennent des 16 règles réelles de detect.mjs : compte, rejetées et exceptions de charte dites', () => {
    const t = plat(grille);
    expect(t).toMatch(/16 rules[^]*seven of the 16 are kept, the nine others are not/);
    for (const s of ['icon-tile-stack', 'hero-eyebrow-chip', 'repeated-section-kickers', 'uniform-low-opacity-shadow', 'monotonous-spacing', 'em-dash-overuse', 'numbered-section-markers', 'aphoristic-cadence', 'theater-slop-phrase']) expect(t, s).toContain(s);
    expect(t).toMatch(/tic-overused-font`[^\n]*flag only when it is not the charter's choice/);
    expect(t).toMatch(/tic-purple-triplet`[^\n]*flag only when it is not the charter's choice/);
  });
  it('R12 — NOTICE donne le fichier, le dépôt, le sha lu et la licence exacte', () => {
    const notice = read('NOTICE');
    expect(notice).toContain('scripts/detect.mjs');
    expect(notice).toContain('https://github.com/ryanthedev/design-for-ai');
    expect(notice).toMatch(/37d7ae63d1afa45eb57ec90bc246cef6dd60c033/);
    expect(notice).toMatch(/MIT/);
    expect(notice).toMatch(/header of scripts\/detect\.mjs/);
    expect(notice).toMatch(/seven are kept[^]*nine are not/);
  });
  it('R12 — LICENSE du paquet reste MIT', () => {
    expect(read('LICENSE')).toMatch(/^MIT License/);
    expect(JSON.parse(read('package.json')).license).toBe('MIT');
  });
  it('R12 — aucun fichier de agents/ ni de templates/orchestrate/ ne contient les chaînes interdites de L448 R8', () => {
    const fichiers = [...readdirSync(join(root, 'agents')).map((f) => `agents/${f}`), ...readdirSync(join(root, 'templates/orchestrate')).map((f) => `templates/orchestrate/${f}`)];
    for (const f of fichiers) for (const s of ['knowledge-work-plugins', 'design-critique', 'ux-copy', 'accessibility-review', 'Anthropic']) expect(read(f), `${f} : ${s}`).not.toContain(s);
  });
});

describe('R13/R14/R15 — formats inchangés, installation, documentation', () => {
  it('R13 — une fiche valide avant le lot passe cadence spec check après le lot', async () => {
    const out: string[] = [];
    const code = await run(['spec', 'check', join(root, 'docs/specs/revue-maquette-criteres-design/fiche.yaml')], { cwd: root, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() });
    expect(code, out.join('\n')).toBe(0);
    expect(empreinte(read('templates/fiche.yaml'))).toBe('4f64486c958a98c0');
  });
  it('R13 — REVIEW_SCHEMA accepte et refuse les mêmes rapports qu’avant', () => {
    expect(empreinte(JSON.stringify(REVIEW_SCHEMA))).toBe('b5e5c47a46ec72e9');
    const rapport = { bloquants: 0, majeurs: 0, mineurs: 1, constats: [{ gravite: 'mineur', texte: 'T1 — tic' }], sousTaches: [], nonVerifie: [], verdict: 'conforme' };
    expect(() => checkShape(rapport, REVIEW_SCHEMA)).not.toThrow();
    expect(() => checkShape({ bloquants: 0 }, REVIEW_SCHEMA)).toThrow(/majeurs/);
  });
  it('R13 — le front matter tools des deux agents est identique à celui d’avant', () => {
    expect(tools(ux)).toBe('tools: Read, Grep, Glob, Bash, mcp__playwright, mcp__plugin_playwright_playwright');
    expect(tools(writer)).toBe('tools: Read, Write, Edit, Grep, Glob, Bash');
  });
  it('R14 — agent installé puis modifié à la main : réinstallation sans --force échoue (code 2) et la copie reste intacte', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.git'));
    const o = { cwd: dir, env: {}, out: () => {}, err: () => {}, now: () => new Date() };
    expect(await run(['skills', 'install'], o)).toBe(0);
    const file = join(dir, '.claude/agents/cadence-ux-reviewer.md');
    writeFileSync(file, 'à la main');
    expect(await run(['skills', 'install'], o)).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe('à la main');
  });
  it('R14 — agent installé non modifié mais d’une version antérieure : refusé sans --force (la copie reste intacte), reçoit le texte renforcé avec --force', () => {
    const dest = join(tempDir(), 'agents');
    mkdirSync(dest, { recursive: true });
    const ancien = read('agents/ux-reviewer.md').replace(/\n## Delivery grid[\s\S]*$/, '\n').replace(/^name: .*$/m, 'name: cadence-ux-reviewer');
    const cible = join(dest, 'cadence-ux-reviewer.md');
    writeFileSync(cible, ancien);
    expect(ancien).not.toContain('## Delivery grid');
    // installAgents compare la copie au texte du paquet, pas à la version qui l'a installée : toute copie différente, même jamais retouchée, passe par --force.
    expect(() => installAgents(AGENTS_DIR, dest, false)).toThrow(/modifié\(s\) localement/);
    expect(readFileSync(cible, 'utf8')).toBe(ancien);
    installAgents(AGENTS_DIR, dest, true);
    expect(readFileSync(cible, 'utf8')).toContain('## Delivery grid');
    expect(readFileSync(join(dest, 'cadence-spec-writer.md'), 'utf8')).toContain('on-<role>');
  });
  it('R15 — CHANGELOG.md, section Unreleased, nomme on-*, contraste.md, la grille et les tics d’IA', () => {
    const s = changelogSectionOf(read('CHANGELOG.md'), 'L513');
    for (const m of ['`on-*`', 'contraste.md', 'delivery grid', 'AI tics', 'Apache-2.0', 'NOTICE']) expect(s, m).toContain(m);
  });
});
