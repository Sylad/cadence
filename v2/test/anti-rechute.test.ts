// Tests anti-rechute (Task 14) : une règle par cause de l'échec du 07-11 (spec §0), sans IA, en quelques secondes.
// Le budget de lignes (C4) vit déjà dans budget.test.ts et n'est pas dupliqué ici.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mesure } from '../src/bench/bras.js';
import { BARRE_SPEC, statut, verdict, type ResultatBanc } from '../src/bench/verdict.js';

const v2 = join(import.meta.dirname, '..');
const depot = join(v2, '..');

function fichiers(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? fichiers(p, ext) : ext.test(e) ? [p] : [];
  });
}
const lire = (p: string) => readFileSync(p, 'utf8');
const src = fichiers(join(v2, 'src'), /\.ts$/);
const briefs = fichiers(join(v2, 'briefs'), /\.md$/);
const brief = (nom: string) => lire(join(v2, 'briefs', nom));

describe('C1, conformité à une fiche figée', () => {
  // `spec:` = la clé de fiche des lots (et non BARRE_SPEC: qui est un identifiant TypeScript).
  const mots: [string, RegExp][] = [['scell', /scell/i], ['acceptation', /acceptation/i], ['fiche', /fiche/i], ['maquette', /maquette/i], ['spec:', /(?<![\w])spec:/i]];
  for (const [mot, re] of mots) {
    it(`aucun fichier de src ni de briefs ne contient « ${mot} »`, () => {
      const trouves = [...src, ...briefs].filter((f) => re.test(lire(f)));
      expect(trouves, `« ${mot} » : la carte décrit, elle ne verrouille rien (spec §0 C1)`).toEqual([]);
    });
  }
  it('le brief du bras candidat contient {{DEMANDE}}', () => expect(brief('bras-equipe-legere.md')).toContain('{{DEMANDE}}'));
  it('le relecteur ne reçoit que la demande et le diff', () => {
    const b = brief('bras-equipe-legere.md');
    expect(b).toContain('le texte de la demande');
    expect(b).toContain('git -C {{CLONE}} diff');
  });
});

describe('C2, contexte découpé', () => {
  for (const f of briefs) {
    it(`brief ${f.split('/').pop()} : pas de nouvelle session ni de claude -p`, () => {
      const t = lire(f).toLowerCase();
      expect(t).not.toContain('nouvelle session');
      expect(t).not.toContain('claude -p');
    });
  }
  it('le juge par défaut est opus', () => {
    const cli = lire(join(v2, 'src', 'bench', 'cli.ts'));
    expect(cli).toMatch(/option\(reste, 'juge'\) \?\? 'opus'/);
  });
  it('aucun modèle sonnet ou haiku n\'écrit le code (src et doc du banc)', () => {
    const cibles = [...src, join(depot, 'docs', 'v2', 'banc.md')].filter(existsSync);
    const trouves = cibles.filter((f) => /modele['"]?\s*[:=]\s*['"]?(sonnet|haiku)|\?\?\s*'(sonnet|haiku)'/i.test(lire(f)));
    expect(trouves).toEqual([]);
  });
});

describe('C3, portes empilées', () => {
  // Spec §0 C3 : « Deux portes au plus : ciblée par le responsable, complète une fois à l'intégration. »
  // Aucun module de porte n'existe encore (ruling R15) : on borne le nombre total de sites (définition ou appel)
  // de fonctions nommées porte*/gate*/verify* dans v2/src, et le budget de lignes du module porte.
  const MAX_SITES_PORTE = 2;
  it('au plus deux sites de porte dans v2/src', () => {
    const sites = src.flatMap((f) => (lire(f).match(/\b(?:porte|gate|verify)\w*\s*\(/gi) ?? []).map((m) => `${f.split('/').pop()}: ${m}`));
    expect(sites.length, sites.join(' ; ')).toBeLessThanOrEqual(MAX_SITES_PORTE);
  });
  it('le budget du module porte reste à 250 lignes au plus', () => {
    const b = JSON.parse(lire(join(v2, 'budget.json'))) as { modules: Record<string, number> };
    expect(b.modules.porte).toBeLessThanOrEqual(250);
  });
});

describe('C4, mécanismes sans mesure', () => {
  it('toute option lue dans v2/src est justifiée dans options.json par un chemin existant', () => {
    const opts = (JSON.parse(lire(join(v2, 'options.json'))) as { options: Record<string, string> }).options;
    const lues = new Set<string>();
    for (const f of src) {
      const t = lire(f);
      for (const m of t.matchAll(/option\(\s*\w+,\s*'([\w-]+)'\s*\)/g)) lues.add(m[1]);
      for (const m of t.matchAll(/includes\(\s*'--([\w-]+)'\s*\)/g)) lues.add(m[1]);
    }
    expect(lues.size).toBeGreaterThan(0);
    for (const o of lues) {
      const cle = Object.keys(opts).find((k) => k.endsWith(` --${o}`));
      expect(cle, `option --${o} sans justification dans v2/options.json : une option neuve demande un rapport de banc où elle gagne`).toBeDefined();
      expect(existsSync(join(depot, opts[cle!])), `${opts[cle!]} n'existe pas`).toBe(true);
    }
  });
});

describe('C5, rattrapages du lead', () => {
  const mes = (bras: string, questions: number, echec: string | null): Mesure =>
    ({ bras, banc: 'b', debut: '', fin: '', duree_s: 100, tokens: 1, cout_usd: 1, questions, questions_texte: [], sessions: [], echec });
  const banc = (o: { questionsC?: number; echecC?: string }): ResultatBanc => ({
    banc: 'b', taille: 'fonction', visible: false, reponses: false, frais: false,
    mesures: { A: mes('A', 0, null), C: mes('C', o.questionsC ?? 0, o.echecC ?? null) },
    jugement: null, fuites: { A: [], C: [] } });
  const critere = (r: ResultatBanc, nom: string) => verdict([r], 'A', 'C', BARRE_SPEC).criteres.find((c) => c.nom === nom);

  it('« questions inutiles » est bloquant et rouge dès une question sans décision', () => {
    expect(critere(banc({ questionsC: 1 }), 'questions inutiles')).toMatchObject({ bloquant: true, ok: false });
  });
  it('« aucun bras en échec » est bloquant et rouge dès un échec', () => {
    expect(critere(banc({ echecC: 'code 1' }), 'aucun bras en échec')).toMatchObject({ bloquant: true, ok: false });
  });
  it('statut refuse la publication sans passage couvrant 1, 3 et 6', () => {
    const ligne = (bancs: string[]) => JSON.stringify({ date: '2026-11-07T10:00:00Z', empreinte: 'e1', vert: true, hebdo: false, frais: 0, bancs });
    const now = new Date('2026-11-07T12:00:00Z');
    expect(statut([ligne(['1-a', '3-b'])], now, 'e1').publication_ok).toBe(false);
    expect(statut([ligne(['1-a', '3-b', '6-c'])], now, 'e1').publication_ok).toBe(true);
  });
});
