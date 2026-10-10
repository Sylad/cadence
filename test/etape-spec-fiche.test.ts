import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// L166 : la fiche d'écran donnée en exemple dans la spec de l'étape spec doit respecter les invariants que la spec énonce.
const SPECS = join(__dirname, '..', 'docs', 'superpowers', 'specs');
const fiche = parse(readFileSync(join(SPECS, '2026-10-10-etape-spec-fiche-exemple.yaml'), 'utf8')) as any;
const spec = readFileSync(join(SPECS, '2026-10-10-etape-spec-design.md'), 'utf8');

describe('fiche d\'écran de l\'exemple (L166)', () => {
  it('déclare l\'écran, ses largeurs de rendu et ses états', () => {
    expect(fiche.ecran.route).toMatch(/^\//);
    expect(fiche.ecran.largeurs).toEqual([1440, 390]);
    expect(fiche.etats).toEqual(expect.arrayContaining(['vide', 'chargement', 'erreur']));
  });

  it('donne à chaque champ un id unique, un libellé, un type, une source et un caractère obligatoire', () => {
    const ids = fiche.champs.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of fiche.champs) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const k of ['libelle', 'type', 'source']) expect(typeof c[k]).toBe('string');
      expect(typeof c.obligatoire).toBe('boolean');
    }
  });

  it('numérote les règles R1… dans l\'ordre, chacune avec un message et un statut sourcée ou hypothèse', () => {
    fiche.regles.forEach((r: any, i: number) => {
      expect(r.id).toBe(`R${i + 1}`);
      expect(typeof r.enonce).toBe('string');
      expect(r.message === null || typeof r.message === 'string').toBe(true); // null : la règle n'a aucun texte à l'écran
      expect(['sourcee', 'hypothese']).toContain(r.statut);
      // une règle sourcée dit d'où elle vient ; une hypothèse dit ce qui la ferait changer
      expect(typeof (r.statut === 'sourcee' ? r.source : r.si_faux)).toBe('string');
    });
  });

  it('ne cite dans les règles et les actions que des champs et des règles qui existent', () => {
    const champs = new Set(fiche.champs.map((c: any) => c.id));
    const regles = new Set(fiche.regles.map((r: any) => r.id));
    for (const r of fiche.regles) for (const c of r.champs ?? []) expect(champs.has(c)).toBe(true);
    for (const a of fiche.actions) {
      expect(a.appel).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/\S+/);
      if (a.declencheur) expect(champs.has(a.declencheur)).toBe(true);
      for (const r of a.regles ?? []) expect(regles.has(r)).toBe(true);
    }
  });

  it('couvre chaque règle par au moins un test d\'acceptation prévu, nommé d\'après elle', () => {
    for (const r of fiche.regles) expect(r.tests?.length).toBeGreaterThan(0);
    for (const r of fiche.regles) for (const t of r.tests) expect(t).toMatch(new RegExp(`^${r.id} — `));
  });

  it('contient au moins une hypothèse, que la spec fait remonter dans l\'entrée Nouveautés', () => {
    expect(fiche.regles.some((r: any) => r.statut === 'hypothese')).toBe(true);
    expect(spec).toMatch(/Hypothèses/);
  });

  it('ne laisse en hypothèse aucune règle dont si_faux touche un choix coûteux à défaire', () => {
    // les 4 catégories de la spec : modèle ou stockage, contrat d'API ou route publiée, action destructive, règle qui en contredit une sourcée
    const couteux = /stockage|modèle de données|clé|migration|donnée utilisateur|contrat d'API|route|URL|destructi|irréversible|suppression|envoi|paiement|contredit|règle sourcée/i;
    for (const r of fiche.regles.filter((x: any) => x.statut === 'hypothese')) expect(r.si_faux).not.toMatch(couteux);
  });

  it('dérive expectations.md sans faux constats : shows exclut les champs propres à un état, api se limite au chargement en GET', () => {
    expect(spec).toMatch(/`shows:`[^`]*\*\*sauf\*\* les champs propres à un état/);
    expect(spec).toMatch(/`api:` = les seules `actions\[\]`\s+de chargement \(`declencheur: null`\) en GET/);
  });

  it('porte l\'état de chaque règle et en déduit shows/never/api sans contredire l\'exemple', () => {
    for (const r of fiche.regles) expect(fiche.etats).toContain(r.etat);
    expect(spec).toMatch(/`etat`/);
    const propres = new Set(fiche.regles.filter((r: any) => r.etat === 'vide' || r.etat === 'erreur').flatMap((r: any) => r.champs ?? []));
    // un champ affiché page chargée ne peut pas être « propre à un état » : il sortirait de shows:
    for (const c of fiche.champs.filter((x: any) => x.obligatoire && x.source !== 'statique')) expect(propres.has(c.id)).toBe(false);
    expect(spec).toMatch(/may be empty when/);
    expect(spec).toMatch(/`never:`[^\n]*règles d'état `erreur`/);
  });

  it('isole les tests d\'acceptation rouges des autres lots du dépôt et étend le verrou à toute session', () => {
    expect(spec).toMatch(/autres lots du dépôt/);
    expect(spec).toMatch(/exclus de `config\.test`/);
    expect(spec).toMatch(/toute session du dépôt/);
  });

  it('sépare l\'essai (S7) de la mesure à 8 lots (S8) et fait dépendre la mise à jour de lead.md de S6', () => {
    const ligne = (id: string) => spec.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';
    expect(ligne('S7')).not.toMatch(/mesure/i);
    expect(ligne('S8')).toMatch(/mesure[\s\S]*8 lots/i);
    expect(ligne('S8')).toMatch(/\| S7 \|$/);
    expect(ligne('S9')).toMatch(/docs\/lead\.md/);
    expect(ligne('S9')).toMatch(/\| S6 \|$/);
  });

  it('rend « — unless » calculable : la clé masque de la règle vide sourcée liste exactement les champs concernés', () => {
    expect(spec).toMatch(/clé `masque`/);
    expect(spec).toMatch(/`shows:`[^\n]*\n?[^\n]*`masque` d'une règle `sourcee` d'état `vide`[\s\S]*?— unless/);
    const ids = new Set(fiche.champs.map((c: any) => c.id));
    const r2 = fiche.regles.find((r: any) => r.etat === 'vide' && r.statut === 'sourcee');
    expect(r2?.masque).toBeTruthy();
    for (const m of r2.masque) expect(ids.has(m)).toBe(true);
    // les champs masqués ne sont pas ceux que la règle fait apparaître
    for (const m of r2.masque) expect(r2.champs).not.toContain(m);
    // les champs obligatoires affichés page chargée (non statiques) sont tous masqués par R2 : ce sont les lignes « — unless »
    const attendus = fiche.champs.filter((c: any) => c.obligatoire && c.source !== 'statique').map((c: any) => c.id).sort();
    expect([...r2.masque].sort()).toEqual(attendus);
  });

  it('écarte les tests d\'acceptation rouges de config.test ET de la CI via la config du lanceur, et le porte dans S5', () => {
    expect(spec).toMatch(/la CI du projet/);
    expect(spec).toMatch(/exclus de `config\.test` et de la CI/);
    expect(spec).toMatch(/`vert: false`/);
    expect(spec).toMatch(/`testPathIgnorePatterns`/);
    const s5 = spec.split('\n').find((l) => l.startsWith('| S5 |')) ?? '';
    expect(s5).toMatch(/CI/);
    expect(s5).toMatch(/config du lanceur/);
    const cmd = spec.split('\n').filter((l) => l.startsWith('raf add '))[4];
    expect(cmd).toMatch(/CI/);
  });

  it('cite l\'erreur et le bouton Réessayer en champs, liés à R3 et à une action', () => {
    for (const id of ['message-erreur', 'bouton-reessayer']) {
      const c = fiche.champs.find((x: any) => x.id === id);
      expect(c?.obligatoire).toBe(false);
    }
    const r3 = fiche.regles.find((r: any) => r.id === 'R3');
    expect(r3.champs).toEqual(expect.arrayContaining(['message-erreur', 'bouton-reessayer']));
    const a = fiche.actions.find((x: any) => x.declencheur === 'bouton-reessayer');
    expect(a?.appel).toBe('GET /api/fixtures/next');
    expect(a?.regles).toContain('R3');
  });

  it('porte dans S5 l\'exclusion de config.test, la commande dédiée et le verrou étendu, et cite spec et id S dans chaque raf add', () => {
    const ligne = (id: string) => spec.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';
    expect(ligne('S5')).toMatch(/acceptation\.json/);
    expect(ligne('S5')).toMatch(/config\.test/);
    expect(ligne('S5')).toMatch(/commande dédiée/);
    expect(ligne('S5')).toMatch(/toutes les sessions|tous les lots/);
    const cmds = spec.split('\n').filter((l) => l.startsWith('raf add '));
    expect(cmds).toHaveLength(9);
    cmds.forEach((l, i) => {
      expect(l).toContain('spec etape-spec');
      expect(l).toContain(`S${i + 1}`);
    });
    expect(cmds[4]).toMatch(/exclu[\s\S]*config\.test/);
    expect(cmds[4]).toMatch(/commande dédiée/);
    expect(cmds[4]).toMatch(/verrou/);
  });

  it('nomme qui pose vert: true et quand (le cycle, à la fin d\'implement/fix, commande dédiée verte), dans la section 5, S5 et sa commande raf add', () => {
    expect(spec).toMatch(/commande dédiée passe, \*\*le cycle\*\*[\s\S]{0,120}pose `vert: true`/);
    const s5 = spec.split('\n').find((l) => l.startsWith('| S5 |')) ?? '';
    expect(s5).toMatch(/`vert: true`/);
    const cmd = spec.split('\n').filter((l) => l.startsWith('raf add '))[4];
    expect(cmd).toMatch(/`?vert: true`?/);
  });
});
