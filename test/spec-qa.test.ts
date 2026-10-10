import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { deriveQa } from '../src/spec.js';
import { tempDir } from './helpers.js';

const root = join(import.meta.dirname, '..');
const exemple = join(root, 'docs', 'superpowers', 'specs', '2026-10-10-etape-spec-fiche-exemple.yaml');
const fiche = () => parse(readFileSync(exemple, 'utf8')) as any;
const lignes = (f: unknown) => deriveQa(f).split('\n');

function cadence(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-10T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cadence spec qa : expectations.md dérivé de la fiche (L170, spec etape-spec S2)', () => {
  it('dérive de l\'exemple la section de la route, sans faux constat', () => {
    expect(deriveQa(fiche())).toBe(
      [
        '## /prochain-match',
        "- shows: Équipe à domicile — unless Sans match programmé, l'écran affiche le message d'état vide et aucun autre champ",
        "- shows: Équipe à l'extérieur — unless Sans match programmé, l'écran affiche le message d'état vide et aucun autre champ",
        "- shows: Date et heure — unless Sans match programmé, l'écran affiche le message d'état vide et aucun autre champ",
        '- never: "Impossible de charger le prochain match."',
        "- api: /api/fixtures/next — may be empty when Sans match programmé, l'écran affiche le message d'état vide et aucun autre champ",
        '',
      ].join('\n'),
    );
  });

  it('shows : les champs obligatoires, sauf ceux qu\'une règle d\'état vide ou erreur fait apparaître (propres à un état)', () => {
    const l = lignes(fiche()).join('\n');
    expect(l).not.toMatch(/shows: Message d'état vide/);
    expect(l).not.toMatch(/shows: Score/); // non obligatoire
    expect(l).not.toMatch(/Me rappeler/);
  });

  it('shows : « — unless » seulement pour un champ du masque d\'une règle sourcée d\'état vide, jamais pour un titre statique', () => {
    const f = fiche();
    f.champs.push({ id: 'titre-page', libelle: 'Titre', type: 'texte', source: 'statique', obligatoire: true });
    const l = lignes(f).filter((x) => x.startsWith('- shows:'));
    expect(l.find((x) => x.includes('Titre'))).toBe('- shows: Titre');
    expect(l.filter((x) => x.includes('— unless'))).toHaveLength(3);
  });

  it('shows : un masque d\'hypothèse ne donne pas de « — unless » (seule une règle sourcée est une raison écrite)', () => {
    const f = fiche();
    f.regles[1].statut = 'hypothese';
    f.regles[1].si_faux = 'Si faux, ce bloc change.';
    delete f.regles[1].source;
    expect(lignes(f).join('\n')).not.toMatch(/unless/);
  });

  it('never : un seul message par règle d\'état erreur ; le message d\'une règle vide n\'y va jamais ; rien si aucun', () => {
    const f = fiche();
    expect(lignes(f).join('\n')).not.toMatch(/Aucun match programmé/);
    f.regles[2].etat = 'charge';
    f.regles[2].champs = [];
    expect(lignes(f).join('\n')).not.toMatch(/never:/);
  });

  it('never : plusieurs messages d\'erreur sur la même ligne, séparés par des virgules', () => {
    const f = fiche();
    f.regles.push({ id: 'R5', etat: 'erreur', enonce: 'Délai dépassé.', message: 'Délai dépassé.', champs: [], statut: 'hypothese', si_faux: 'Un autre texte.', tests: ['R5 — délai'] });
    expect(lignes(f)).toContain('- never: "Impossible de charger le prochain match.", "Délai dépassé."');
  });

  it('api : seulement les actions de chargement en GET (jamais un POST ni une action déclenchée par un champ)', () => {
    const l = lignes(fiche()).filter((x) => x.startsWith('- api:'));
    expect(l).toHaveLength(1);
    expect(l[0]).toMatch(/^- api: \/api\/fixtures\/next/);
    const f = fiche();
    f.actions[1].appel = 'POST /api/fixtures/next';
    expect(lignes(f).filter((x) => x.startsWith('- api:'))).toEqual([]);
  });

  it('api : sans règle sourcée d\'état vide sur l\'action, pas de « may be empty when »', () => {
    const f = fiche();
    f.actions[1].regles = ['R1', 'R3'];
    expect(lignes(f)).toContain('- api: /api/fixtures/next');
  });

  it('shows : plusieurs règles sourcées vides masquant le même champ, énoncés joints par « ; »', () => {
    const f = fiche();
    f.regles.push({ id: 'R5', etat: 'vide', enonce: 'Hors saison, aucun match.', message: 'Hors saison.', champs: ['message-vide'], masque: ['equipe-domicile'], statut: 'sourcee', source: 'demande du lot', tests: ['R5 — hors saison'] });
    expect(lignes(f)).toContain('- shows: Équipe à domicile — unless Sans match programmé, l\'écran affiche le message d\'état vide et aucun autre champ ; Hors saison, aucun match');
  });

  it('api : plusieurs règles sourcées vides portant l\'action de chargement, énoncés joints par « ; »', () => {
    const f = fiche();
    f.regles.push({ id: 'R5', etat: 'vide', enonce: 'Hors saison, aucun match.', message: 'Hors saison.', champs: ['message-vide'], statut: 'sourcee', source: 'demande du lot', tests: ['R5 — hors saison'] });
    f.actions[1].regles = ['R1', 'R2', 'R5'];
    expect(lignes(f)).toContain('- api: /api/fixtures/next — may be empty when Sans match programmé, l\'écran affiche le message d\'état vide et aucun autre champ ; Hors saison, aucun match');
  });

  it('refuse une fiche invalide (les écarts de spec check, rien dérivé)', () => {
    const f = fiche();
    f.regles[1].masque = ['fantome'];
    expect(() => deriveQa(f)).toThrow(/masque.*fantome/);
  });
});

describe('cadence spec qa en ligne de commande', () => {
  it('imprime la section sur la sortie standard, code 0', () => {
    const r = cadence(tempDir(), 'spec', 'qa', exemple);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toBe('## /prochain-match');
    expect(r.out).toMatch(/- never: "Impossible/);
  });

  it('sur une fiche invalide : écarts sur la sortie d\'erreur, rien sur la sortie standard, code 1', () => {
    const dir = tempDir();
    const f = fiche();
    f.regles[1].masque = ['fantome'];
    writeFileSync(join(dir, 'fiche.yaml'), JSON.stringify(f));
    const r = cadence(dir, 'spec', 'qa', 'fiche.yaml');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/✗ R2.*masque/);
  });

  it('usage : un seul argument, la fiche', () => {
    expect(cadence(tempDir(), 'spec', 'qa').code).toBe(2);
    expect(cadence(tempDir(), 'spec', 'qa', 'a', 'b').code).toBe(2);
  });
});
