import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { checkFiche, deriveQa, summary } from '../src/spec.js';
import { tempDir } from './helpers.js';

// cadence spec check, partie back (L187, spec etape-spec-back B2) : sujet, cas, règles, contrats, données.
const root = join(import.meta.dirname, '..');
const specs = join(root, 'docs', 'superpowers', 'specs');
const exempleBack = join(specs, '2026-10-11-etape-spec-back-fiche-exemple.yaml');
const exempleEcran = join(specs, '2026-10-10-etape-spec-fiche-exemple.yaml');
const gabarit = join(root, 'templates', 'fiche-back.yaml');
const lire = (f: string) => parse(readFileSync(f, 'utf8')) as any;
const back = () => lire(exempleBack);

function cadence(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-11T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Fiche mixte : la fiche back, plus la partie écran de l'exemple d'écran ; ses appels deviennent des contrats communs (ids A communs). */
function mixte() {
  const f = back();
  const e = lire(exempleEcran);
  f.sujet.id = e.ecran.id;
  f.sujet.lot = e.ecran.lot = 'L34';
  f.ecran = e.ecran;
  f.etats = e.etats;
  f.champs = e.champs;
  // les règles d'écran suivent les règles back : R11…
  const n = f.regles.length;
  const decale = (id: string) => `R${Number(id.slice(1)) + n}`;
  for (const r of e.regles) f.regles.push({ ...r, id: decale(r.id), tests: r.tests.map((t: string) => t.replace(`${r.id} — `, `${decale(r.id)} — `)) });
  f.contrats.push({ id: 'A5', appel: 'POST /api/fixtures/next/reminder', entree: 'aucune', sortie: 'rappel enregistré', erreurs: [{ code: 'HTTP 409', message: 'Rappel déjà demandé' }], regles: ['R14'] });
  f.actions = [
    { id: 'A6', declencheur: 'bouton-rappel', contrat: 'A5', regles: ['R14'] },
    { id: 'A7', declencheur: null, contrat: 'A1', regles: ['R12', 'R13'] },
  ];
  return f;
}

describe('cadence spec check : la fiche back (L187)', () => {
  it('accepte l\'exemple de la fiche back et le gabarit livré', () => {
    expect(checkFiche(back())).toEqual([]);
    expect(checkFiche(lire(gabarit))).toEqual([]);
  });

  it('une fiche sans ecran ni sujet est refusée et dit les deux clés possibles', () => {
    const p = checkFiche({ regles: [] }).join('\n');
    expect(p).toMatch(/sujet/);
    expect(p).toMatch(/ecran/);
  });

  it('exige les clés de sujet, un id en kebab-case et un périmètre', () => {
    const f = back();
    delete f.sujet.titre;
    f.sujet.id = 'Cache De Secours';
    f.sujet.perimetre = { modules: [], endpoints: [], jobs: [] };
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/sujet\.titre/);
    expect(p).toMatch(/sujet\.id.*kebab-case/);
    expect(p).toMatch(/sujet\.perimetre.*au moins/);
    delete f.sujet.perimetre;
    expect(checkFiche(f).join('\n')).toMatch(/sujet\.perimetre/);
  });

  it('exige des cas C1… sans trou, ni doublon', () => {
    const f = back();
    f.cas[1].id = 'C3';
    expect(checkFiche(f).join('\n')).toMatch(/cas n° 2.*C2.*C3/);
    const g = back();
    delete g.cas;
    expect(checkFiche(g).join('\n')).toMatch(/cas : liste non vide/);
  });

  it('exige d\'un cas ses clés, des étapes nominales, et une alternative ou une raison de n\'en avoir aucune', () => {
    const f = back();
    delete f.cas[0].acteur;
    f.cas[0].nominal = [];
    f.cas[2].alternatives = [];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/C1 : acteur manquant/);
    expect(p).toMatch(/C1 : nominal/);
    expect(p).toMatch(/C3 : .*sans_alternative/);
    f.cas[2].sans_alternative = 'le job ne fait que réécrire le cache ; son seul échec est R7';
    expect(checkFiche(f).join('\n')).not.toMatch(/C3 :/);
  });

  it('exige d\'une alternative si, alors et des règles qui existent', () => {
    const f = back();
    f.cas[0].alternatives[0].regles = ['R99'];
    f.cas[0].alternatives[1].regles = [];
    delete f.cas[0].alternatives[2].alors;
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/C1.*alternative n° 1.*R99/);
    expect(p).toMatch(/C1.*alternative n° 2.*au moins une règle/);
    expect(p).toMatch(/C1.*alternative n° 3.*alors/);
  });

  it('exige d\'une règle back un cas existant, un statut et sa justification, un test nommé Rn — …', () => {
    const f = back();
    f.regles[0].cas = ['C9'];
    f.regles[1].cas = [];
    delete f.regles[2].statut;
    f.regles[3].tests = [];
    f.regles[4].tests = ['un test mal nommé'];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/R1 : cas « C9 » absent/);
    expect(p).toMatch(/R2 : .*rattachée à au moins un cas/);
    expect(p).toMatch(/R3 : statut/);
    expect(p).toMatch(/R4 : au moins un test/);
    expect(p).toMatch(/R5 : le test « un test mal nommé » doit être nommé « R5 — … »/);
  });

  it('numérote les règles R1… sans trou', () => {
    const f = back();
    f.regles[2].id = 'R7';
    expect(checkFiche(f).join('\n')).toMatch(/règle n° 3.*R3.*R7/);
  });

  it('refuse une règle qui n\'est rattachée ni à un cas ni à un état, et message/champs/masque sur une règle sans état', () => {
    const f = back();
    delete f.regles[0].cas;
    f.regles[1].message = 'texte';
    f.regles[2].champs = ['x'];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/R1 : .*rattachée à au moins un cas/);
    expect(p).toMatch(/R2 : message.*règle rattachée à un état/);
    expect(p).toMatch(/R3 : champs.*règle rattachée à un état/);
  });

  it('refuse un cas qu\'aucune règle ne cite', () => {
    const f = back();
    f.cas.push({ id: 'C4', titre: 't', acteur: 'a', declencheur: 'd', preconditions: ['p'], nominal: ['n'], alternatives: [{ si: 's', alors: 'a', regles: ['R1'] }], resultat: 'r' });
    expect(checkFiche(f).join('\n')).toMatch(/C4 : aucune règle ne le cite/);
  });

  it('exige d\'un contrat un appel de la bonne forme, une entrée, une sortie, des erreurs en { code, message } ou sans_erreur, des règles qui existent', () => {
    const f = back();
    f.contrats[0].appel = 'lineup';
    delete f.contrats[1].sortie;
    f.contrats[2].erreurs = [{ code: '500', message: 'x' }, { code: 'log warn' }];
    f.contrats[3].erreurs = [];
    f.contrats[0].regles = ['R42'];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/A1 : appel « lineup » invalide/);
    expect(p).toMatch(/A2 : sortie manquant/);
    expect(p).toMatch(/A3 : .*code « 500 »/);
    expect(p).toMatch(/A3 : .*message/);
    expect(p).toMatch(/A4 : .*sans_erreur/);
    expect(p).toMatch(/A1 : règle « R42 » absente/);
    f.contrats[3].sans_erreur = 'le job ne renvoie rien à un appelant';
    expect(checkFiche(f).join('\n')).not.toMatch(/A4 :/);
  });

  it('accepte les trois formes d\'appel : VERBE /chemin, job <nom>, commande <nom>', () => {
    const f = back();
    f.contrats[0].appel = 'POST /api/x/:id';
    f.contrats[2].appel = 'job nettoyage';
    f.contrats[3].appel = 'commande purge-cache';
    expect(checkFiche(f).join('\n')).not.toMatch(/appel/);
    f.contrats[3].appel = 'commande raf spec';
    expect(checkFiche(f).join('\n')).not.toMatch(/appel/);
    f.contrats[3].appel = 'commande cadence spec check';
    expect(checkFiche(f).join('\n')).not.toMatch(/appel/);
    f.contrats[3].appel = 'commande ';
    expect(checkFiche(f).join('\n')).toMatch(/A4 : appel/);
  });

  it('numérote les contrats A1… sans trou', () => {
    const f = back();
    f.contrats[1].id = 'A5';
    expect(checkFiche(f).join('\n')).toMatch(/A5|contrat n° 2/);
  });

  it('exige les données D1… ; toucher une donnée existante exige la décision du lead', () => {
    const f = back();
    f.donnees[0].modification = 'changement';
    f.donnees[1].modification = 'peut-etre';
    f.donnees.push({ id: 'D3', objet: 'table x', existant: false, modification: 'ajout', note: 'nouvelle' });
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/D1 : .*existante.*decision/);
    expect(p).toMatch(/D2 : modification « peut-etre »/);
    expect(p).not.toMatch(/D3 :/);
    f.donnees[0].decision = 'réponse du lead : changement validé';
    expect(checkFiche(f).join('\n')).not.toMatch(/D1 :/);
    const g = back();
    g.donnees = [{ id: 'D2', objet: 'x', existant: true, modification: 'aucune', note: 'n' }];
    expect(checkFiche(g).join('\n')).toMatch(/donnée n° 1.*D1.*D2/);
    delete g.donnees;
    expect(checkFiche(g).join('\n')).toMatch(/donnees : liste attendue/);
  });

  it('une fiche d\'écran seule reste valide telle quelle (aucune migration) et n\'exige pas sujet', () => {
    expect(checkFiche(lire(exempleEcran))).toEqual([]);
    expect(checkFiche(lire(join(root, 'templates', 'fiche.yaml')))).toEqual([]);
  });
});

describe('cadence spec check : la fiche mixte (sujet et ecran)', () => {
  it('accepte une fiche mixte dont les ids A sont communs aux actions et aux contrats', () => {
    expect(checkFiche(mixte())).toEqual([]);
  });

  it('exige que sujet.id et ecran.id, sujet.lot et ecran.lot soient les mêmes', () => {
    const f = mixte();
    f.ecran.id = 'autre';
    f.ecran.lot = 'L99';
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/sujet\.id.*ecran\.id/);
    expect(p).toMatch(/sujet\.lot.*ecran\.lot/);
  });

  it('refuse un trou dans les ids A communs, et un id partagé entre une action et un contrat', () => {
    const f = mixte();
    f.actions[0].id = 'A9';
    expect(checkFiche(f).join('\n')).toMatch(/A.*sans trou.*A6/);
    const g = mixte();
    g.actions[0].id = 'A5';
    expect(checkFiche(g).join('\n')).toMatch(/« A5 » en double/);
  });

  it('une action renvoie à un contrat qui existe, sans répéter son appel', () => {
    const f = mixte();
    f.actions[0].contrat = 'A42';
    expect(checkFiche(f).join('\n')).toMatch(/A6 : contrat « A42 » absent/);
    const g = mixte();
    g.actions[0].appel = 'GET /x';
    expect(checkFiche(g).join('\n')).toMatch(/A6 : .*contrat.*appel/);
  });

  it('une règle peut être rattachée à un état ou à des cas, mais à l\'un des deux au moins', () => {
    const f = mixte();
    const nue = f.regles.find((r: any) => r.id === 'R12');
    delete nue.etat;
    expect(checkFiche(f).join('\n')).toMatch(/R12 : .*rattachée/);
  });

  it('un état inconnu reste refusé dans une fiche mixte', () => {
    const f = mixte();
    f.regles.find((r: any) => r.id === 'R12').etat = 'fantome';
    expect(checkFiche(f).join('\n')).toMatch(/R12 : état « fantome » inconnu/);
  });
});

describe('cadence spec check : suites de la revue L187 (L192)', () => {
  it('accepte les niveaux de log des piles du parc (NestJS, Python, Node) comme code d\'erreur', () => {
    for (const niveau of ['debug', 'log', 'warn', 'error', 'warning', 'info', 'critical', 'fatal', 'verbose']) {
      const f = back();
      f.contrats[0].erreurs = [{ code: `log ${niveau}`, message: 'x' }];
      expect(checkFiche(f), niveau).toEqual([]);
    }
    const g = back();
    g.contrats[0].erreurs = [{ code: 'log trace', message: 'x' }];
    expect(checkFiche(g).join('\n')).toMatch(/A1 : erreur n° 1 : code « log trace » invalide/);
  });

  it('une fiche back seule : une règle avec etat reçoit un seul écart, sans exiger de message', () => {
    const f = back();
    f.regles[0].etat = 'vide';
    const p = checkFiche(f).filter((m) => m.startsWith('R1 :'));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/etat n'a de sens que dans une fiche qui a une partie écran/);
  });

  it('une fiche back seule refuse actions, etats et champs (sans ecran) au lieu de les ignorer', () => {
    const f = back();
    f.actions = [{ id: 'A1', declencheur: null, appel: 'GET /x' }];
    f.etats = ['vide', 'chargement', 'erreur'];
    f.champs = [{ id: 'x', libelle: 'X', type: 'texte', source: 's', obligatoire: true }];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/actions : .*partie écran/);
    expect(p).toMatch(/etats : .*partie écran/);
    expect(p).toMatch(/champs : .*partie écran/);
    // des listes vides ou nulles ne disent rien : le gabarit reste valide
    const g = back();
    g.actions = null;
    expect(checkFiche(g)).toEqual([]);
  });

  it('une fiche mixte : une action qui répète l\'appel d\'un contrat sans contrat: est refusée', () => {
    const f = mixte();
    delete f.actions[0].contrat;
    f.actions[0].appel = 'POST /api/fixtures/next/reminder';
    expect(checkFiche(f).join('\n')).toMatch(/A6 : .*appel.*contrat A5.*contrat: A5/);
    // un appel propre, absent des contrats, reste accepté
    f.actions[0].appel = 'POST /api/autre';
    expect(checkFiche(f)).toEqual([]);
  });
});

describe('cadence spec check : branches de la fiche back sans test jusque-là (L192)', () => {
  it('hors_perimetre : liste de textes, nulle ou absente', () => {
    const f = back();
    f.sujet.perimetre.hors_perimetre = null;
    expect(checkFiche(f)).toEqual([]);
    f.sujet.perimetre.hors_perimetre = ['le front'];
    expect(checkFiche(f)).toEqual([]);
    f.sujet.perimetre.hors_perimetre = 'le front';
    expect(checkFiche(f).join('\n')).toMatch(/sujet\.perimetre\.hors_perimetre : liste de textes/);
    f.sujet.perimetre.hors_perimetre = ['ok', ''];
    expect(checkFiche(f).join('\n')).toMatch(/hors_perimetre : liste de textes/);
  });

  it('fiche mixte : l\'id d\'un contrat est de la forme A<n>, et celui d\'une action est exigé', () => {
    const f = mixte();
    f.contrats[4].id = 'X5';
    expect(checkFiche(f).join('\n')).toMatch(/contrat n° 5 : l'id doit être de la forme A<n>/);
    const g = mixte();
    delete g.actions[0].id;
    expect(checkFiche(g).join('\n')).toMatch(/action n° 1 : id manquant/);
  });

  it('un élément qui n\'est pas un objet est refusé : cas, règle, action, contrat, donnée, champ, alternative, erreur', () => {
    const f = back();
    f.cas[0] = 'C1';
    f.cas[1].alternatives = ['si'];
    f.regles[0] = 'R1';
    f.contrats[0] = 'A1';
    f.contrats[1].erreurs = ['HTTP 404'];
    f.donnees[0] = 'D1';
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/cas n° 1 : objet attendu/);
    expect(p).toMatch(/C2 : alternative n° 1 : objet attendu/);
    expect(p).toMatch(/règle n° 1 : objet attendu/);
    expect(p).toMatch(/contrat n° 1 : objet attendu/);
    expect(p).toMatch(/A2 : erreur n° 1 : objet \{ code, message \} attendu/);
    expect(p).toMatch(/donnée n° 1 : objet attendu/);
    const e = mixte();
    e.champs[0] = 'x';
    e.actions[0] = 'A6';
    const q = checkFiche(e).join('\n');
    expect(q).toMatch(/champ n° 1 : objet attendu/);
    expect(q).toMatch(/action n° 1 : objet attendu/);
  });

  it('un champ sans id est refusé', () => {
    const f = mixte();
    delete f.champs[0].id;
    expect(checkFiche(f).join('\n')).toMatch(/champ n° 1 : id manquant/);
  });
});

describe('cadence spec check en ligne de commande, fiche back', () => {
  it('code 0 et un résumé des cas, règles, contrats et données', () => {
    const r = cadence(tempDir(), 'spec', 'check', exempleBack);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/fiche valide.*3 cas.*10 règles.*\d hypothèses.*4 contrats.*2 données/);
  });

  it('le résumé d\'une fiche d\'écran ne change pas, celui d\'une mixte dit les deux parties', () => {
    expect(summary(lire(exempleEcran))).toMatch(/fiche valide : 8 champs, 4 règles \(2 hypothèses\), 3 actions$/);
    expect(summary(mixte())).toMatch(/8 champs.*2 actions.*3 cas.*5 contrats.*2 données/);
  });

  it('code 1 et un écart par ligne pour une fiche back qui viole un invariant', () => {
    const dir = tempDir();
    const f = back();
    f.regles[0].tests = [];
    f.donnees[0].modification = 'ajout';
    writeFileSync(join(dir, 'fiche.yaml'), JSON.stringify(f));
    const r = cadence(dir, 'spec', 'check', 'fiche.yaml');
    expect(r.code).toBe(1);
    expect(r.out.split('\n').filter((l) => l.startsWith('✗ '))).toHaveLength(2);
    expect(r.out).toMatch(/2 écart\(s\)/);
  });

  it('spec qa refuse une fiche qui n\'a pas de partie écran, et dérive la partie écran d\'une fiche mixte', () => {
    const r = cadence(tempDir(), 'spec', 'qa', exempleBack);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/pas de partie écran/);
    const qa = deriveQa(mixte());
    expect(qa).toMatch(/^## \/prochain-match/);
    expect(qa).toMatch(/- api: \/api\/lineup/);
  });
});

describe('gabarit templates/fiche-back.yaml', () => {
  it('est un gabarit commenté qui passe cadence spec check tel quel et renvoie au README', () => {
    const t = readFileSync(gabarit, 'utf8');
    expect(t).toMatch(/^#/);
    expect(t).toMatch(/README/);
    expect(t).not.toMatch(/docs\/superpowers/);
    expect(cadence(tempDir(), 'spec', 'check', gabarit).code).toBe(0);
  });

  it('montre chaque clé de la fiche back', () => {
    const t = readFileSync(gabarit, 'utf8');
    for (const k of ['sujet:', 'perimetre:', 'cas:', 'alternatives:', 'sans_alternative', 'regles:', 'contrats:', 'sans_erreur', 'donnees:', 'decision']) expect(t).toContain(k);
  });
});
