import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBrief } from '../src/orchestrate/briefs.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const MARQUEUR = '[L447]';
const count = (text: string) => text.split(MARQUEUR).length - 1;
const mesure = read('../docs/mesures/bug-code-2026-10-30.md');
const vars = { chemin: '/r/p', lot: 'L9', titre: 'Un titre', objectif: 'faire X', commits: 'c1', reponse: '', constats: 'un constat', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };

/** Le texte de `implement.md` rendu, découpé en sections par ligne vide. */
const implement = read('../templates/orchestrate/implement.md');
const section = (titre: string) => implement.slice(implement.indexOf(titre)).split('\n\n')[0]!;
const LIMITS = section('Limits and rules, before the walkthrough');
const SELF_CHECK = section('Self-check before handing back');
/** Les quatre emplacements de la table de R8, par maillon. */
const EMPLACEMENTS = {
  'brief implement': LIMITS,
  'auto-vérification avant rendu': SELF_CHECK,
  'porte locale': read('../src/testgate.ts'),
  fiche: read('../templates/orchestrate/spec-back.md'),
} as const;
const designe = /Maillon dominant\s*:?\*{0,2}\s*(?:le\s+)?\*{0,2}(brief implement|auto-vérification avant rendu|porte locale|fiche|aucun)/i.exec(mesure.replace(/\*\*/g, ''))?.[1]?.toLowerCase() as keyof typeof EMPLACEMENTS | 'aucun' | undefined;

describe('R8 — un seul mécanisme, au maillon désigné', () => {
  it('R8 — le document cite le maillon et l\'emplacement (fichier et section) du mécanisme', () => {
    expect(designe, 'le document nomme le maillon dominant').toBeDefined();
    expect(designe).not.toBe('aucun');
    expect(mesure).toContain('templates/orchestrate/implement.md');
    expect(mesure).toContain('Limits and rules, before the walkthrough');
  });

  it('R8 — le marqueur [L447] est dans la section du maillon désigné, une seule fois', () => {
    expect(count(EMPLACEMENTS[designe as keyof typeof EMPLACEMENTS])).toBe(1);
    expect(count(implement)).toBe(1);
  });

  it('R8 — le marqueur [L447] est absent des trois autres emplacements, dont l\'autre section de implement.md', () => {
    for (const [maillon, texte] of Object.entries(EMPLACEMENTS)) if (maillon !== designe) expect(count(texte), maillon).toBe(0);
    expect(count(SELF_CHECK)).toBe(0);
  });

  it('R8 — le document contient le tableau des sous-causes et le protocole de mesure', () => {
    for (const s of ['cas limite', 'test cassé', 'contrat mal lu', 'appelant oublié', 'affirmation fausse', 'test vide', 'autre']) expect(mesure, s).toContain(`| ${s} |`);
    expect(mesure).toContain('Protocole de mesure sur deux fenêtres');
    expect(mesure).toContain('Part conforme du premier coup');
    expect(mesure).toContain('| F2 (après) |');
  });

  it('R8 — aucun maillon dominant : aucun marqueur [L447] dans les quatre emplacements', () => {
    // Le document dit « aucun » si, et seulement si, aucun emplacement ne porte le marqueur.
    const posés = Object.values(EMPLACEMENTS).reduce((n, t) => n + count(t), 0);
    expect(posés === 0).toBe(designe === 'aucun');
    expect(posés).toBeLessThanOrEqual(1);
  });

  it('R8 — le marqueur [L447] n\'est dans aucun autre gabarit de brief', () => {
    for (const kind of ['fix', 'review', 'spec', 'spec-back', 'accept'] as const) expect(count(renderBrief(kind, vars)), kind).toBe(0);
  });
});

describe('R11 — le brief implement garde un seul bloc', () => {
  it('R11 — maillon brief implement : la section Limits and rules garde un seul bloc et porte [L447] une fois', () => {
    expect(designe).toBe('brief implement');
    const out = renderBrief('implement', vars);
    expect(out.split('Limits and rules, before the walkthrough').length - 1).toBe(1);
    expect(count(out)).toBe(1);
    // la puce est précisée, non doublée : une seule puce « edge cases » dans le bloc
    expect(LIMITS.split('\n').filter((l) => l.startsWith('- edge cases')).length).toBe(1);
    expect(LIMITS.split('\n').find((l) => l.startsWith('- edge cases'))).toContain(MARQUEUR);
  });

  it('R11 — le document de mesure date le départ de la fenêtre et dit que L428 et L447 sont mesurés ensemble', () => {
    expect(mesure).toMatch(/lignes « après » de L428 .*sont vides/);
    expect(mesure).toContain('L428 et L447 ensemble');
    expect(mesure).toContain('2026-10-30');
  });
});
