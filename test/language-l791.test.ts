import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { readOrchestrateConfig } from '../src/config.js';
import { languageText, readLanguage, requiredStates, templateName } from '../src/language.js';
import { acceptText } from '../src/orchestrate/accept.js';
import { specText } from '../src/orchestrate/spec.js';
import { checkFiche, deriveQa } from '../src/spec.js';
import { git } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

// L791 (issue #67) : la clé `language:` de cadence.yaml. Avec `en`, ce que cadence écrit dans le projet est en anglais ; sans la clé, rien ne change.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

/** Les commentaires d'un fichier JS (`//` et `/* … *\/`), hors chaînes et expressions régulières simples. */
function comments(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const line of src.split('\n')) {
    const i = line.search(/(^|\s)\/\/ /);
    if (i >= 0) out.push(line.slice(i));
  }
  return out;
}

/** Un mot ou un signe qui trahit le français : une lettre accentuée, ou un mot outil courant. */
const FRENCH = /[àâçéèêëîïôûùüÿœ«»]|\b(le|la|les|des|du|une|est|pour|avec|sans|dans|qui|fichiers? de|chemin|attendu|illisible|posé)\b/i;

const cadenceYaml = (dir: string, text: string) => {
  writeFileSync(join(dir, 'cadence.yaml'), text);
  return join(dir, 'cadence.yaml');
};

describe('L791 — la clé language: de cadence.yaml', () => {
  it('absente : undefined, comme avant ; fr et en lus ; toute autre valeur refusée', () => {
    const dir = tempDir();
    expect(readLanguage(cadenceYaml(dir, 'plan: .cadence/raf.yaml\n'))).toBeUndefined();
    expect(readOrchestrateConfig(join(dir, 'cadence.yaml')).language).toBeUndefined();
    expect(readLanguage(cadenceYaml(dir, 'language: en\n'))).toBe('en');
    expect(readOrchestrateConfig(join(dir, 'cadence.yaml')).language).toBe('en');
    expect(readLanguage(cadenceYaml(dir, 'language: fr\n'))).toBe('fr');
    expect(() => readLanguage(cadenceYaml(dir, 'language: de\n'))).toThrow(/language : fr ou en attendu/);
    expect(() => readOrchestrateConfig(cadenceYaml(dir, 'language: english\n'))).toThrow(/language/);
  });
});

describe('L791 — le gabarit du lanceur copié dans le projet', () => {
  it('en anglais : aucun commentaire ni message français ; en français : le gabarit d’avant', () => {
    expect(templateName('acceptation-runner.mjs', 'en')).toBe('acceptation-runner.en.mjs');
    expect(templateName('acceptation-runner.mjs')).toBe('acceptation-runner.mjs');
    expect(templateName('acceptation-runner.mjs', 'fr')).toBe('acceptation-runner.mjs');
    const en = read('templates/acceptation-runner.en.mjs');
    const notes = comments(en);
    expect(notes.length).toBeGreaterThan(5);
    for (const c of notes) expect(c, c).not.toMatch(FRENCH);
    for (const m of en.matchAll(/new Error\(([^\n]*)\)/g)) expect(m[1], m[1]).not.toMatch(FRENCH);
    // le témoin : le gabarit français en a bien, la détection n'est pas aveugle
    expect(comments(read('templates/acceptation-runner.mjs')).some((c) => FRENCH.test(c))).toBe(true);
  });

  it('les deux gabarits font la même chose (mêmes exports, mêmes fichiers rendus)', async () => {
    const fr = await import(pathToFileURL(join(root, 'templates/acceptation-runner.mjs')).href);
    const en = await import(pathToFileURL(join(root, 'templates/acceptation-runner.en.mjs')).href);
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    const dir = tempDir();
    for (const [ecran, lot, doc] of [['a', 'L1', { fichiers: ['web/t/a.spec.ts', 't/b.test.ts'], vert: false }], ['b', 'L2', { fichiers: ['t/c.test.ts'], vert: true }], ['c', 'L3', { fichiers: ['e2e/d.spec.ts'], vert: true, e2e: true }]] as const) {
      mkdirSync(join(dir, 'docs/specs', ecran), { recursive: true });
      writeFileSync(join(dir, 'docs/specs', ecran, `acceptation-${lot}.json`), JSON.stringify({ lot, fiche: `docs/specs/${ecran}/fiche.yaml`, ...doc }));
    }
    for (const format of ['glob', 'regex']) {
      expect(en.acceptationIgnored(dir, 'docs/specs', format)).toEqual(fr.acceptationIgnored(dir, 'docs/specs', format));
      expect(en.acceptationE2e(dir, 'docs/specs', format)).toEqual(fr.acceptationE2e(dir, 'docs/specs', format));
    }
    expect(en.acceptationIgnored(dir)).toEqual(['web/t/a.spec.ts', 't/b.test.ts', 'e2e/d.spec.ts']);
    const file = join(dir, 'docs/specs/a/acceptation-L1.json');
    expect(en.acceptationOnly(file, 'web')).toEqual(fr.acceptationOnly(file, 'web'));
    expect(en.acceptationOnly(file)).toEqual(fr.acceptationOnly(file));
    expect(() => en.acceptationOnly('')).toThrow(/CADENCE_ACCEPTATION/);
  });
});

describe('L791 — les consignes du spec-writer et de l’acceptance-writer', () => {
  const accept = { fiche: 'docs/specs/x/fiche.yaml', maquette: 'docs/specs/x/maquette.html', acceptation: 'docs/specs/x/acceptation-L1.json', command: 'npx vitest run -c vitest.acceptation.config.ts', runner: '// runner' };

  it('avec language: en, les deux briefs demandent l’anglais (tests, commentaires, règles, états anglais)', () => {
    const a = acceptText({ ...accept, language: 'en' });
    expect(a).toContain('Language of the project files: English');
    expect(a).toMatch(/comment, test name/);
    expect(a).toContain('the runner template below is the English one');
    const s = specText({ dir: 'docs/specs', screen: 'page', language: 'en' });
    expect(s).toContain('Language of the project files: English');
    for (const e of ['empty', 'loading', 'error', 'loaded']) expect(s).toContain(`\`${e}\``);
    expect(s).toContain('#etat-empty');
    const back = specText({ dir: 'docs/specs', back: true, language: 'en' });
    expect(back).toContain('Language of the project files: English');
  });

  it('sans la clé, ou avec fr, les briefs sont ceux d’avant, mot pour mot', () => {
    expect(acceptText({ ...accept, language: 'fr' })).toBe(acceptText(accept));
    expect(acceptText(accept)).not.toContain('Language of the project files');
    expect(specText({ dir: 'docs/specs', screen: 'page', language: 'fr' })).toBe(specText({ dir: 'docs/specs', screen: 'page' }));
    expect(specText({ dir: 'docs/specs', screen: 'page' })).not.toContain('Language of the project files');
    expect(languageText(undefined, 'spec')).toBe('');
    expect(languageText('fr', 'accept')).toBe('');
  });

  it('les gabarits de fiche anglais existent à côté des français et les agents disent quoi faire d’une langue nommée', () => {
    for (const f of ['fiche.yaml', 'fiche-back.yaml', 'acceptation-runner.mjs']) {
      expect(existsSync(join(root, 'templates', templateName(f, 'en'))), f).toBe(true);
    }
    for (const a of ['agents/spec-writer.md', 'agents/acceptance-writer.md']) expect(read(a), a).toContain('**Language of the project files.**');
  });
});

describe('L791 — cadence spec check suit la langue du projet', () => {
  it('la fiche anglaise du gabarit passe en en, pas sans la clé (états français attendus) ; la française passe sans la clé', () => {
    const en = parse(read('templates/fiche.en.yaml'));
    expect(checkFiche(en, 'en')).toEqual([]);
    expect(checkFiche(en).join('\n')).toMatch(/« vide », « chargement », « erreur » manquant/);
    expect(checkFiche(parse(read('templates/fiche.yaml')))).toEqual([]);
    expect(checkFiche(parse(read('templates/fiche.yaml')), 'en').join('\n')).toMatch(/« empty », « loading », « error » manquant/);
    expect(checkFiche(parse(read('templates/fiche-back.en.yaml')), 'en')).toEqual([]);
    expect(requiredStates('en')).toEqual(['empty', 'loading', 'error']);
  });

  it('en anglais, masque appartient à l’état empty et la section QA se dérive des états anglais', () => {
    const doc = parse(read('templates/fiche.en.yaml'));
    doc.regles[0].etat = 'loading';
    expect(checkFiche(doc, 'en').join('\n')).toContain('masque n\'a de sens que pour une règle d\'état « empty »');
    const qa = deriveQa(parse(read('templates/fiche.en.yaml')), 'en');
    expect(qa).toContain('- shows: List of items — unless With no item, the screen shows the empty state message instead of the list');
    expect(qa).toContain('- never: "The items could not be loaded."');
    expect(qa).not.toContain('Empty state message');
  });

  it('la commande lit language: dans le cadence.yaml du dépôt : noms de tests et états anglais acceptés, refusés sans la clé', async () => {
    const dir = tempDir();
    git(dir, 'init', '-q');
    mkdirSync(join(dir, 'docs/specs/my-screen'), { recursive: true });
    writeFileSync(join(dir, 'docs/specs/my-screen/fiche.yaml'), read('templates/fiche.en.yaml'));
    const check = async () => {
      const out: string[] = [];
      const code = await run(['spec', 'check', 'docs/specs/my-screen/fiche.yaml'], { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() });
      return { code, out: out.join('\n') };
    };
    cadenceYaml(dir, 'language: en\n');
    const en = await check();
    expect(en.code, en.out).toBe(0);
    expect(en.out).toContain('fiche valide');
    cadenceYaml(dir, 'plan: .cadence/raf.yaml\n');
    const sans = await check();
    expect(sans.code).toBe(1);
    expect(sans.out).toContain('« vide », « chargement », « erreur » manquant');
    const out: string[] = [];
    cadenceYaml(dir, 'language: en\n');
    expect(await run(['spec', 'qa', 'docs/specs/my-screen/fiche.yaml'], { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() })).toBe(0);
    expect(out.join('\n')).toContain('## /my-screen');
  });
});
