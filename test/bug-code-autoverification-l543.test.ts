import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { SOUS_CAUSES } from '../src/corrections.js';
import { changelogSectionOf } from './changelog-section.js';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(path(p), 'utf8');
const MARQUEUR = '[L543]';
const count = (text: string, m = MARQUEUR) => text.split(m).length - 1;
const MESURE = 'docs/mesures/bug-code-2026-11-03.md';
const mesure = read(`../${MESURE}`);
const implement = read('../templates/orchestrate/implement.md');
const section = (titre: string) => implement.slice(implement.indexOf(titre)).split('\n\n')[0]!;
const SELF_CHECK = section('Self-check before handing back');
const LIMITS = section('Limits and rules, before the walkthrough');
const PUCES = SELF_CHECK.split('\n').filter((l) => l.startsWith('- ') && l.includes(MARQUEUR));
const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };

/** Libellé du tableau de la commande → identifiant de SOUS_CAUSES. */
const LIBELLES: Record<string, (typeof SOUS_CAUSES)[number]> = {
  'cas limite': 'cas-limite', 'test cassé': 'test-casse', 'contrat mal lu': 'contrat-mal-lu', 'appelant oublié': 'appelant-oublie',
  'affirmation fausse': 'affirmation-fausse', 'test vide': 'test-vide', autre: 'autre',
};
/** Les lignes du tableau « Sous-cause | Passes | Part » du document, dans l'ordre du document. */
const tableau = [...mesure.matchAll(/^\| (cas limite|test cassé|contrat mal lu|appelant oublié|affirmation fausse|test vide|autre) \| (\d+) \|/gm)].map((m) => ({ cause: LIBELLES[m[1]!]!, passes: Number(m[2]) }));
/** Les causes retenues, lues sur la ligne « Causes retenues : … » du document. */
const ligneRetenues = /^Causes retenues\s*:\s*(.+)$/m.exec(mesure)?.[1] ?? '';
const retenues = ligneRetenues.replace(/\*\*/g, '').split(/,|\bet\b/).map((s) => LIBELLES[s.trim().replace(/\.$/, '').replace(/\s*\(.*$/, '')]).filter((c): c is (typeof SOUS_CAUSES)[number] => c !== undefined);
/** La règle R1 : les plus lourdes hors « autre », égalité dans l'ordre de SOUS_CAUSES, au plus deux, les vides exclues. */
const attendues = tableau
  .filter((l) => l.cause !== 'autre' && l.passes > 0)
  .sort((a, b) => b.passes - a.passes || SOUS_CAUSES.indexOf(a.cause) - SOUS_CAUSES.indexOf(b.cause))
  .slice(0, 2)
  .map((l) => l.cause);

/** Les termes que R3 fixe pour la puce de chaque sous-cause que la mesure peut retenir (« autre » n'a pas de texte). */
const TERMES: Record<string, RegExp[]> = {
  'cas-limite': [/entrée/i, /attendu/i, /obtenu/i, /L447/],
  'test-casse': [/importent/i],
  'contrat-mal-lu': [/mot de la règle/i, /ligne de code/i],
  'appelant-oublie': [/fichier:ligne/i, /appelants/i],
  'affirmation-fausse': [/la commande ou la ligne qui/i],
  'test-vide': [/ligne cassée/i],
};
/** Quelle puce porte quelle sous-cause : l'ordre des puces suit l'ordre des causes retenues du document. */
const puceDe = (cause: string) => PUCES[retenues.indexOf(cause as (typeof SOUS_CAUSES)[number])]!;

describe('R1 — les deux causes dominantes viennent du tableau mesuré', () => {
  it('R1 — le document de mesure contient le tableau des sept sous-causes et nomme exactement deux causes retenues', () => {
    expect(tableau.map((l) => l.cause).sort()).toEqual([...SOUS_CAUSES].sort());
    expect(ligneRetenues, 'ligne « Causes retenues : … »').not.toBe('');
    expect(retenues).toHaveLength(2);
    expect(new Set(retenues).size).toBe(2);
  });

  it('R1 — les deux causes nommées sont les deux plus lourdes du tableau du document, « autre » exclue', () => {
    expect(retenues).toEqual(attendues);
    expect(retenues).not.toContain('autre');
  });

  it('R1 — égalité en deuxième place : l\'ordre de SOUS_CAUSES tranche (cas du tableau du document)', () => {
    const [, second] = retenues;
    const ex = tableau.filter((l) => l.cause !== 'autre' && l.cause !== retenues[0] && l.cause !== second && l.passes === tableau.find((t) => t.cause === second)!.passes);
    // toutes les causes à égalité avec la deuxième passent derrière elle dans SOUS_CAUSES
    for (const e of ex) expect(SOUS_CAUSES.indexOf(second!)).toBeLessThanOrEqual(SOUS_CAUSES.indexOf(e.cause));
    // et le document dit la part des deux causes parmi les passes bug-code
    expect(mesure).toMatch(/Part des deux causes[^\n]*\d+ %/);
  });
});

describe('R2 — la mesure est celle de la commande existante', () => {
  it('R2 — le document de mesure donne la commande exacte et la fenêtre (--since), et dit si Ollama a répondu', () => {
    expect(mesure).toContain('cadence corrections --classify --since 2026-10-27 --cache <copie de corrections.json> --cache-sous-causes <copie de corrections-sous-causes.json>');
    expect(mesure).toMatch(/Ollama a répondu|Ollama n'a pas répondu/);
  });

  it('R2 — le document ne compte aucune passe classée à la main : chaque ligne du tableau vient de la commande ou du tableau du 30-10 daté', () => {
    expect(mesure).toMatch(/aucune passe n'est classée à la main/i);
    const dit = /Ollama a répondu/.test(mesure);
    if (dit) expect(mesure).toMatch(/sous-classées sur \d+/);
    else {
      expect(mesure).toContain('bug-code-2026-10-30.md');
      expect(mesure).toContain('non remesurées');
    }
    // la somme du tableau est le nombre de passes bug-code annoncé
    const total = Number(/(\d+) passes sous-classées sur (\d+)/.exec(mesure)?.[2]);
    expect(tableau.reduce((n, l) => n + l.passes, 0)).toBe(total);
  });
});

describe('R3 — les puces [L543] de la liste Self-check', () => {
  it('R3 — implement.md rendu : la liste Self-check porte exactement autant de puces [L543] que de causes retenues par le document de mesure (une ou deux)', () => {
    const out = renderBrief('implement', vars);
    expect(retenues.length).toBeGreaterThanOrEqual(1);
    expect(PUCES).toHaveLength(retenues.length);
    expect(count(out)).toBe(retenues.length);
    for (const p of PUCES) expect(count(p), p).toBe(1);
  });

  it('R3 — chaque puce [L543] demande une vérification sur le diff et une trace dans le rapport (resume, choix ou nonVerifie)', () => {
    for (const p of PUCES) {
      expect(p, p).toMatch(/diff/i);
      expect(p, p).toMatch(/"resume"|"choix"|"nonVerifie"/);
    }
  });

  it('R3 — pour chaque sous-cause retenue par le document de mesure, le texte de la puce [L543] contient les termes fixés pour cette sous-cause', () => {
    for (const c of retenues) for (const t of TERMES[c] ?? []) expect(puceDe(c), `${c} ${t}`).toMatch(t);
  });

  it('R3 — puce cas-limite (si retenue) : ne contient pas la liste des cas d\'entrée du point L447 et renvoie à L447 ; elle exige la trace dans resume et nonVerifie', () => {
    if (!retenues.includes('cas-limite')) return;
    const p = puceDe('cas-limite');
    for (const mot of [/\bvide\b/i, /\babsent/i, /deux fois/i, /mauvais ordre/i, /mauvais type/i, /refusé/i]) expect(p).not.toMatch(mot);
    expect(p).toContain('L447');
    expect(p).not.toContain('[L447]');
    expect(p).toContain('"resume"');
    expect(p).toContain('"nonVerifie"');
  });

  it('R3 — le document de mesure ne retient jamais « autre » et chaque sous-cause retenue a un texte de puce dans R3', () => {
    expect(retenues).not.toContain('autre');
    for (const c of retenues) expect(Object.keys(TERMES), c).toContain(c);
  });

  it('R3 — [L543] n\'est pas dans le bloc « Limits and rules » et [L447] reste une seule fois dans implement.md et jamais dans Self-check', () => {
    expect(count(LIMITS)).toBe(0);
    expect(count(implement, '[L447]')).toBe(1);
    expect(count(SELF_CHECK, '[L447]')).toBe(0);
    expect(count(LIMITS, '[L447]')).toBe(1);
  });

  it('R3 — le brief rendu n\'a aucune accolade restante et les cinq puces existantes de Self-check sont inchangées', () => {
    expect(renderBrief('implement', vars)).not.toMatch(/\{\{\w+\}\}/);
    const anciennes = SELF_CHECK.split('\n').filter((l) => l.startsWith('- ') && !l.includes(MARQUEUR));
    expect(anciennes).toHaveLength(5);
    const debuts = ['- documentation: the README and the architecture documentation', '- tests: one test per rule of the fiche,', '- no dead code, and no test that cannot fail', '- screens: for a modified screen,', '- no false comment: a comment'];
    debuts.forEach((d, i) => expect(anciennes[i], d).toMatch(new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
    expect(SELF_CHECK).toContain('- no false comment: a comment, a docstring or a message never describes a behaviour the code no longer has or does not have.');
    // les puces [L543] viennent après les cinq existantes, avant la phrase de clôture
    expect(SELF_CHECK.split('\n').findIndex((l) => l.includes(MARQUEUR))).toBeGreaterThan(5);
  });
});

describe('R4 — le durcissement est limité au gabarit implement.md', () => {
  it('R4 — [L543] est absent de tous les gabarits de templates/orchestrate sauf implement.md', () => {
    const dir = path('../templates/orchestrate');
    const fichiers = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(fichiers).toContain('implement.md');
    for (const f of fichiers) expect(count(readFileSync(`${dir}/${f}`, 'utf8')), f).toBe(f === 'implement.md' ? retenues.length : 0);
  });

  it('R4 — [L543] est absent de src/testgate.ts', () => {
    expect(count(read('../src/testgate.ts'))).toBe(0);
  });
});

describe('R5 — le protocole de mesure sur deux fenêtres', () => {
  it('R5 — le document contient le protocole F1/F2 avec la ligne « Avant » remplie et les lignes F1 et F2 « à mesurer »', () => {
    const avant = /^\| Avant[^\n]*$/m.exec(mesure)?.[0] ?? '';
    expect(avant).not.toBe('');
    expect(avant).not.toContain('à mesurer');
    expect(avant).toMatch(/\d+ %/);
    for (const f of ['F1', 'F2']) {
      const ligne = new RegExp(`^\\| ${f} \\(après\\)[^\\n]*$`, 'm').exec(mesure)?.[0] ?? '';
      expect(ligne, f).toContain('à mesurer');
    }
    for (const col of ['Part conforme du premier coup', 'Passes classées', 'bug de code', 'Lots à ≥ 2 passes']) expect(mesure).toContain(col);
    // une colonne par cause retenue
    for (const c of retenues) expect(mesure.split('\n').find((l) => l.startsWith('| Fenêtre'))).toContain(Object.keys(LIBELLES).find((k) => LIBELLES[k] === c)!);
  });

  it('R5 — le document donne le dénominateur (toutes les passes moins les sans revue) et la borne de mise en service', () => {
    expect(mesure).toMatch(/toutes les passes de la fenêtre moins celles « sans revue \(tests rouges\) »/);
    expect(mesure).toContain('mise en service');
    expect(mesure).toContain('npm run service');
    expect(mesure).toMatch(/part conforme[^\n]*monte[^\n]*ET[^\n]*baisse/);
  });

  it('R5 — la commande cadence perf du protocole est bornée par --since (mise en service) et lancée le dernier jour de la fenêtre', () => {
    const lignes = mesure.split('\n').filter((l) => /^cadence perf\b/.test(l));
    expect(lignes.length).toBeGreaterThan(0);
    for (const l of lignes) expect(l).toMatch(/--since </);
    expect(mesure).toMatch(/dernier jour de (la fenêtre|F)/);
    expect(mesure).not.toMatch(/prennent les mêmes bornes pour les deux commandes/);
  });

  it('R5 — le document dit que L428, L447 et L497 sont mesurés ensemble', () => {
    expect(mesure).toMatch(/L428, L447 et L497[^\n]*ensemble/);
  });
});

describe('R6 — la documentation suit', () => {
  it('R6 — docs/orchestrate.md cite [L543] et le chemin du document de mesure, qui existe', () => {
    const doc = read('../docs/orchestrate.md');
    const ligne = doc.split('\n').find((l) => l.includes(MARQUEUR));
    expect(ligne).toBeDefined();
    expect(ligne).toContain('mesures/bug-code-2026-11-03.md');
    expect(existsSync(path(`../${MESURE}`))).toBe(true);
    // sous le paragraphe L447
    expect(doc.indexOf(MARQUEUR)).toBeGreaterThan(doc.indexOf('The edge-cases point, sharpened (L447)'));
    // la part conforme a baissé (63 % → 45 %) : la ligne ne la dit pas stable
    expect(ligne).not.toMatch(/did not move the first-time/);
    expect(ligne).toContain('63 % → 45 %');
    // aucune figure non vérifiée : celles de la ligne viennent du document de mesure
    for (const n of ligne!.match(/\b\d+(?: %)?/g) ?? []) if (n !== '543') expect(mesure, n).toContain(n.replace(' %', ''));
  });

  it('R6 — le CHANGELOG et whats-new citent L543', () => {
    expect(changelogSectionOf(read('../CHANGELOG.md'), 'L543')).not.toBe('');
    expect(read('../docs/whats-new.md')).toContain('L543');
  });
});
