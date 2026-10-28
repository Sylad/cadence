import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CODE_ERREUR } from '../src/spec.js';
import { costlyHypotheses } from '../src/orchestrate/spec.js';
import { lotsDuPlanReel } from './plan-reel.js';

// Design de l'étape spec des lots sans écran (back) : la fiche donnée en exemple doit respecter les invariants que le design énonce,
// et le design doit dire des chiffres et des lots ce que le plan et la mesure de référence disent.
const ROOT = join(__dirname, '..');
const SPECS = join(ROOT, 'docs', 'superpowers', 'specs');
const fiche = parse(readFileSync(join(SPECS, '2026-10-11-etape-spec-back-fiche-exemple.yaml'), 'utf8')) as any;
const design = readFileSync(join(SPECS, '2026-10-11-etape-spec-back-design.md'), 'utf8');
const mesure = readFileSync(join(ROOT, 'docs', 'mesures', 'corrections-2026-10-10.md'), 'utf8');
// Le plan par le chargeur : actifs et archivés (les lots B1–B5 sont clos, donc archivés par `raf archive`).
const plan = { lots: lotsDuPlanReel() };

const ligne = (md: string, debut: string) => md.split('\n').find((l) => l.startsWith(debut)) ?? '';
const ids = (liste: any[]) => liste.map((x) => x.id);
const sansTrou = (liste: any[], prefixe: string) => ids(liste).forEach((id, i) => expect(id).toBe(`${prefixe}${i + 1}`));

describe('fiche back de l\'exemple (étape spec back)', () => {
  it('déclare le sujet, son lot et son périmètre, sans aucune partie écran', () => {
    expect(fiche.sujet.id).toMatch(/^[a-z][a-z0-9-]*$/);
    for (const k of ['titre', 'lot']) expect(typeof fiche.sujet[k]).toBe('string');
    for (const k of ['modules', 'endpoints', 'jobs']) expect(fiche.sujet.perimetre[k].length).toBeGreaterThan(0);
    // la partie écran n'est exigée que pour un lot à screen:
    for (const k of ['ecran', 'etats', 'champs', 'actions']) expect(fiche[k]).toBeUndefined();
    for (const r of fiche.regles) for (const k of ['etat', 'message', 'champs', 'masque']) expect(r[k]).toBeUndefined();
  });

  it('numérote les cas C1… sans trou, chacun avec des étapes nominales, un résultat, et une alternative ou une raison de n\'en avoir aucune', () => {
    sansTrou(fiche.cas, 'C');
    const regles = new Set(ids(fiche.regles));
    for (const c of fiche.cas) {
      for (const k of ['titre', 'acteur', 'declencheur', 'resultat']) expect(typeof c[k]).toBe('string');
      expect(c.preconditions.length).toBeGreaterThan(0);
      expect(c.nominal.length).toBeGreaterThan(0);
      if (c.alternatives.length === 0) expect(typeof c.sans_alternative).toBe('string');
      for (const a of c.alternatives) {
        expect(typeof a.si).toBe('string');
        expect(typeof a.alors).toBe('string');
        expect(a.regles.length).toBeGreaterThan(0); // chaque alternative renvoie à des règles
        for (const r of a.regles) expect(regles.has(r)).toBe(true);
      }
    }
  });

  it('numérote les règles R1… sans trou, rattache chacune à un cas existant et dit d\'où elle vient ou ce qui changerait', () => {
    sansTrou(fiche.regles, 'R');
    const cas = new Set(ids(fiche.cas));
    for (const r of fiche.regles) {
      expect(typeof r.enonce).toBe('string');
      expect(r.cas.length).toBeGreaterThan(0);
      for (const c of r.cas) expect(cas.has(c)).toBe(true);
      expect(['sourcee', 'hypothese']).toContain(r.statut);
      expect(typeof (r.statut === 'sourcee' ? r.source : r.si_faux)).toBe('string');
    }
  });

  it('prévoit au moins un test par règle, nommé d\'après elle, et cite chaque cas dans au moins une règle', () => {
    for (const r of fiche.regles) {
      expect(r.tests.length).toBeGreaterThan(0);
      for (const t of r.tests) expect(t).toMatch(new RegExp(`^${r.id} — `));
    }
    const cites = new Set(fiche.regles.flatMap((r: any) => r.cas));
    for (const c of ids(fiche.cas)) expect(cites.has(c)).toBe(true);
  });

  it('porte des contrats A1… sans trou : appel de la bonne forme, erreurs en { code, message } ou raison de n\'en avoir aucune, règles existantes', () => {
    sansTrou(fiche.contrats, 'A');
    const regles = new Set(ids(fiche.regles));
    for (const a of fiche.contrats) {
      expect(a.appel).toMatch(/^((GET|POST|PUT|PATCH|DELETE) \/\S+|job \S+|commande \S+)$/);
      for (const k of ['entree', 'sortie']) expect(typeof a[k]).toBe('string');
      if (a.erreurs.length === 0) expect(typeof a.sans_erreur).toBe('string');
      for (const e of a.erreurs) {
        expect(e.code).toMatch(CODE_ERREUR);
        expect(e.message.length).toBeGreaterThan(0);
      }
      for (const r of a.regles) expect(regles.has(r)).toBe(true);
    }
  });

  it('ne cite en contrats que des endpoints et des jobs du périmètre, et chaque endpoint et job du périmètre a son contrat', () => {
    const appels = fiche.contrats.map((a: any) => a.appel);
    const perimetre = [...fiche.sujet.perimetre.endpoints, ...fiche.sujet.perimetre.jobs.map((j: string) => `job ${j}`)];
    expect([...appels].sort()).toEqual([...perimetre].sort());
  });

  it('déclare les données touchées D1… ; toucher une donnée existante exige la décision du lead', () => {
    sansTrou(fiche.donnees, 'D');
    for (const d of fiche.donnees) {
      expect(typeof d.objet).toBe('string');
      expect(typeof d.existant).toBe('boolean');
      expect(['aucune', 'ajout', 'changement']).toContain(d.modification);
      if (d.existant && d.modification !== 'aucune') expect(typeof d.decision).toBe('string');
    }
  });

  it('contient des hypothèses et aucune dont si_faux touche un choix coûteux à défaire (le garde-fou du programme)', () => {
    expect(fiche.regles.some((r: any) => r.statut === 'hypothese')).toBe(true);
    expect(costlyHypotheses(fiche)).toEqual([]);
  });

  it('fait servir à chaque message d\'erreur d\'un contrat une règle qui le porte (le warning de R8 est dans A1 et A2)', () => {
    const r8 = fiche.regles.find((r: any) => r.id === 'R8');
    expect(r8.enonce).toContain('Serving expired');
    for (const id of ['A1', 'A2']) {
      const a = fiche.contrats.find((x: any) => x.id === id);
      expect(a.regles).toContain('R8');
      expect(a.erreurs.some((e: any) => e.message.startsWith('Serving expired'))).toBe(true);
    }
  });
});

describe('design de l\'étape spec back', () => {
  it('énonce les sept décisions validées', () => {
    const table = design.split('## Décisions')[1]!.split('## Ce qui est repris')[0]!;
    for (const sujet of ['Seuil', 'Format', 'Revue de la fiche', 'Validation humaine', 'Tests d\'acceptation', 'Hypothèses', 'Mesure']) {
      expect(table).toMatch(new RegExp(`^\\| ${sujet} \\|`, 'm'));
    }
    expect(table).toMatch(/`spec: true`[\s\S]*`raf spec <lot> on\\\|off`[\s\S]*L185/);
    expect(table).toMatch(/deux passes au plus/);
  });

  it('reprend les quatre catégories coûteuses de la spec écran, instanciées pour le back', () => {
    const q = design.split('### 3. Question ciblée')[1]!.split('### 4.')[0]!;
    for (const cat of ['Modèle ou stockage', 'Contrat d\'API public ou route publiée', 'Action irréversible', 'Contradiction avec une règle sourcée']) expect(q).toContain(cat);
  });

  it('cite la référence recalculée depuis la mesure : lots non visibles, 208 / 135 (65 %) / 61 (29 %)', () => {
    const nv = ligne(mesure, '| non visibles |').split('|').map((c) => c.trim());
    const v = ligne(mesure, '| visibles |').split('|').map((c) => c.trim());
    const total = ligne(mesure, '| **Total** |').split('|').map((c) => c.trim());
    const n = (cell: string) => Number(cell.match(/^(\d+)/)![1]);
    const lots = n(nv[2]!);
    const un = n(nv[3]!);
    const deux = n(nv[4]!);
    // la ligne « non visibles » est le total moins les visibles : le recalcul doit retomber sur elle
    expect(n(total[2]!) - n(v[2]!)).toBe(lots);
    expect(n(total[3]!) - n(v[3]!)).toBe(un);
    expect(n(total[4]!) - n(v[4]!)).toBe(deux);
    const pct = (x: number) => Math.round((100 * x) / lots);
    expect(design).toContain(`**${lots} lots non visibles**`);
    expect(design).toContain(`${un} sur ${lots}`);
    expect(design).toContain(`${deux} sur ${lots}`);
    expect(design).toMatch(new RegExp(`\\*\\*${pct(un)} %\\*\\* \\(${un}\\)`));
    expect(design).toMatch(new RegExp(`\\*\\*${pct(deux)} %\\*\\* \\(${deux}\\)`));
    expect(ligne(design, '| lots avec au moins 1 correction')).toContain(`${pct(un)} % (${un} sur ${lots})`);
    expect(ligne(design, '| lots avec au moins 2 corrections')).toContain(`${pct(deux)} % (${deux} sur ${lots})`);
  });

  it('fixe la réussite à ≤ 40 % et ≤ 15 %, sous la référence, et garde L176 inchangé', () => {
    expect(ligne(design, '| lots avec au moins 1 correction')).toMatch(/≤ 40 %/);
    expect(ligne(design, '| lots avec au moins 2 corrections')).toMatch(/≤ 15 %/);
    expect(design).toMatch(/L176[^\n]*inchangé/);
    expect(design).toMatch(/à partir de \*\*8 lots\*\*/);
  });

  it('découpe le plan en B1–B5 en chaîne, et le plan du dépôt porte ces lots avec les mêmes titres, estimations et dépendances', () => {
    const cmds = design.split('\n').filter((l) => l.startsWith('raf add '));
    expect(cmds).toHaveLength(5);
    const tableau = design.split('\n').filter((l) => /^\| L\d+ \(B\d\) \|/.test(l));
    expect(tableau).toHaveLength(5);
    const estimations = [0.5, 1, 1, 0.5, 0.5];
    cmds.forEach((cmd, i) => {
      const [, titre, estimate] = cmd.match(/^raf add "(.*)" --estimate ([\d.]+)/)!;
      expect(titre).toContain(`spec etape-spec-back, B${i + 1})`);
      expect(Number(estimate)).toBe(estimations[i]);
      const id = tableau[i]!.match(/^\| (L\d+) \(B(\d)\)/)!;
      expect(id[2]).toBe(String(i + 1));
      const lot = plan.lots.find((l) => l.id === id[1]);
      expect(lot?.title).toBe(titre);
      // B3 (L188) a été réestimé à 2 j au plan le 11-10 (trois sessions d'écriture) : le design garde l'estimation d'origine.
      expect(lot?.estimate).toBe(id[1] === 'L188' ? 2 : estimations[i]);
      // chaîne : B1 sans dépendance, chaque autre après le précédent, dans la commande comme dans le plan
      const apres = cmd.match(/--after (L\d+)/)?.[1];
      if (i === 0) {
        expect(apres).toBeUndefined();
        expect(lot?.after).toEqual([]); // le chargeur normalise l'absence de dépendance en liste vide
      } else {
        expect(apres).toBe(tableau[i - 1]!.match(/^\| (L\d+)/)![1]);
        expect(lot?.after).toEqual([apres]);
      }
    });
  });

  it('couvre dans le plan les cinq morceaux du brief : champ spec, format de fiche, étape et revue, liste de lanceurs, mesure', () => {
    const l = (b: string) => design.split('\n').find((x) => new RegExp(`^\\| L\\d+ \\(${b}\\) \\|`).test(x)) ?? '';
    expect(l('B1')).toMatch(/`raf add --spec`[\s\S]*`raf spec <lot> on\\\|off`[\s\S]*`raf check`[\s\S]*README \+ CHANGELOG/);
    expect(l('B2')).toMatch(/`cadence spec check`[\s\S]*2026-10-11-etape-spec-back-fiche-exemple\.yaml/);
    expect(l('B3')).toMatch(/gabarit spec back[\s\S]*`code-reviewer` en mode fiche/i);
    expect(l('B4')).toMatch(/`orchestrate\.accept` en liste de lanceurs/);
    expect(l('B5')).toMatch(/8 lots/);
  });

  it('montre une liste de lanceurs valide et nomme la règle de racine', () => {
    const bloc = design.match(/```yaml\n([\s\S]*?)```/)![1]!;
    const accept = (parse(bloc) as any).orchestrate.accept as string[];
    expect(Array.isArray(accept)).toBe(true);
    expect(accept).toHaveLength(2);
    for (const cmd of accept) expect(cmd).toMatch(/^cd (frontend|backend) && /);
    expect(design).toMatch(/Chaque lanceur ne prend que les fichiers sous sa racine/);
    expect(design).toMatch(/CADENCE_ACCEPTATION[\s\S]{0,40}chaque/);
  });

  it('place les hypothèses en note du lot et dans le tableau final de la vague, pas dans une entrée Nouveautés', () => {
    const h = design.split('### 7. Hypothèses visibles')[1]!.split('## Mesure')[0]!;
    expect(h).toMatch(/note du lot[^\n]*`raf note`/);
    expect(h).toMatch(/tableau final de la vague/);
    expect(h).toMatch(/Discord/);
    expect(h).toMatch(/pas d'entrée Nouveautés/);
  });

  it('nomme le garde-fou existant et le point du cycle que B3 doit changer', () => {
    expect(design).toContain('costlyHypotheses');
    expect(design).toContain('`l.screen || l.spec`');
  });
});
