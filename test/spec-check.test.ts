import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { checkFiche } from '../src/spec.js';
import { tempDir } from './helpers.js';

const root = join(import.meta.dirname, '..');
const exemple = join(root, 'docs', 'superpowers', 'specs', '2026-10-10-etape-spec-fiche-exemple.yaml');
const fiche = () => parse(readFileSync(exemple, 'utf8')) as any;

function cadence(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-10T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cadence spec check : les invariants de la fiche (L170, spec etape-spec S2)', () => {
  it('accepte la fiche de l\'exemple et le gabarit livré', () => {
    expect(checkFiche(fiche())).toEqual([]);
    expect(checkFiche(parse(readFileSync(join(root, 'templates', 'fiche.yaml'), 'utf8')))).toEqual([]);
  });

  it('refuse un document qui n\'est pas une fiche', () => {
    expect(checkFiche(null)[0]).toMatch(/fiche/);
    expect(checkFiche('texte')[0]).toMatch(/fiche/);
    expect(checkFiche({}).length).toBeGreaterThan(0);
  });

  it('exige les clés de ecran, une route absolue et les largeurs 1440 et 390', () => {
    const f = fiche();
    delete f.ecran.titre;
    f.ecran.route = 'prochain-match';
    f.ecran.largeurs = [1440];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/ecran\.titre/);
    expect(p).toMatch(/ecran\.route/);
    expect(p).toMatch(/ecran\.largeurs/);
  });

  it('exige les états vide, chargement et erreur, sans doublon', () => {
    const f = fiche();
    f.etats = ['vide', 'charge', 'charge'];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/états.*chargement/);
    expect(p).toMatch(/états.*« charge » en double/);
  });

  it('refuse un id de champ en double ou mal formé, un champ sans libellé, type, source, ni obligatoire booléen', () => {
    const f = fiche();
    f.champs.push({ ...f.champs[0] });
    f.champs.push({ id: 'Mauvais_Id', libelle: 'x', type: 'texte', source: 'statique', obligatoire: true });
    f.champs.push({ id: 'sans-type', libelle: 'x', source: 'statique', obligatoire: 'oui' });
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/champ « equipe-domicile » en double/);
    expect(p).toMatch(/Mauvais_Id.*kebab-case/);
    expect(p).toMatch(/sans-type.*type/);
    expect(p).toMatch(/sans-type.*obligatoire/);
  });

  it('refuse des règles qui ne sont pas numérotées R1… sans trou', () => {
    const f = fiche();
    f.regles[2].id = 'R5';
    expect(checkFiche(f).join('\n')).toMatch(/règle n° 3.*R3.*R5/);
  });

  it('exige un état connu, un énoncé, un message (texte ou null) et un statut', () => {
    const f = fiche();
    f.regles[0].etat = 'ailleurs';
    delete f.regles[1].enonce;
    delete f.regles[2].message;
    f.regles[3].statut = 'peut-etre';
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/R1.*état « ailleurs »/);
    expect(p).toMatch(/R2.*enonce/);
    expect(p).toMatch(/R3.*message/);
    expect(p).toMatch(/R4.*statut/);
  });

  it('exige la source d\'une règle sourcée et le si_faux d\'une hypothèse, vides refusés', () => {
    const f = fiche();
    f.regles[0].source = '  ';
    delete f.regles[2].si_faux;
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/R1.*source/);
    expect(p).toMatch(/R3.*si_faux/);
  });

  it('exige au moins un test par règle, nommé « Rn — … »', () => {
    const f = fiche();
    f.regles[0].tests = [];
    f.regles[1].tests = ['R1 — mauvais numéro'];
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/R1.*au moins un test/);
    expect(p).toMatch(/R2.*« R1 — mauvais numéro ».*R2 — /);
  });

  it('refuse une règle ou une action qui cite un champ ou une règle absents', () => {
    const f = fiche();
    f.regles[0].champs = ['score', 'fantome'];
    f.actions[0].declencheur = 'bouton-inconnu';
    f.actions[1].regles = ['R1', 'R9'];
    f.actions[2].appel = 'FETCH /x';
    const p = checkFiche(f).join('\n');
    expect(p).toMatch(/R1.*champ « fantome »/);
    expect(p).toMatch(/A1.*déclencheur « bouton-inconnu »/);
    expect(p).toMatch(/A2.*règle « R9 »/);
    expect(p).toMatch(/A3.*appel/);
  });

  it('refuse des actions non numérotées A1… ou en double', () => {
    const f = fiche();
    f.actions[1].id = 'A1';
    expect(checkFiche(f).join('\n')).toMatch(/action n° 2.*A2.*A1/);
  });

  it('refuse un masque qui cite un champ absent de la fiche (note de revue L166)', () => {
    const f = fiche();
    f.regles[1].masque = ['equipe-domicile', 'champ-fantome'];
    expect(checkFiche(f).join('\n')).toMatch(/R2.*masque.*champ « champ-fantome »/);
  });

  it('refuse un masque qui n\'est pas une liste, qui masque un champ que la règle fait apparaître, ou qui est posé hors état vide', () => {
    let f = fiche();
    f.regles[1].masque = 'equipe-domicile';
    expect(checkFiche(f).join('\n')).toMatch(/R2.*masque.*liste/);
    f = fiche();
    f.regles[1].masque = ['message-vide'];
    expect(checkFiche(f).join('\n')).toMatch(/R2.*masque.*« message-vide ».*champs/);
    f = fiche();
    f.regles[0].masque = ['date-match'];
    expect(checkFiche(f).join('\n')).toMatch(/R1.*masque.*état « vide »/);
  });

  it('n\'impose pas de masque : une règle vide sans masque est valide', () => {
    // pas d'invariant sur la complétude du masque : seul « spec qa » en tire les « — unless »
    const f = fiche();
    delete f.regles[1].masque;
    expect(checkFiche(f)).toEqual([]);
  });
});

describe('cadence spec check en ligne de commande', () => {
  it('code 0 et un résumé pour une fiche valide', () => {
    const r = cadence(tempDir(), 'spec', 'check', exemple);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/fiche valide.*8 champs.*4 règles.*2 hypothèses.*3 actions/);
  });

  it('code 1 et un écart par ligne pour une fiche qui viole un invariant', () => {
    const dir = tempDir();
    const f = fiche();
    f.regles[1].masque = ['fantome'];
    f.regles[0].tests = [];
    writeFileSync(join(dir, 'fiche.yaml'), JSON.stringify(f));
    const r = cadence(dir, 'spec', 'check', 'fiche.yaml');
    expect(r.code).toBe(1);
    const lignes = r.out.split('\n').filter((l) => l.startsWith('✗ '));
    expect(lignes).toHaveLength(2);
    expect(r.out).toMatch(/2 écart\(s\)/);
  });

  it('code 2 si le fichier manque, est illisible, ou si l\'usage est mauvais', () => {
    const dir = tempDir();
    expect(cadence(dir, 'spec', 'check', 'absente.yaml')).toMatchObject({ code: 2 });
    writeFileSync(join(dir, 'casse.yaml'), 'a: [1, 2');
    expect(cadence(dir, 'spec', 'check', 'casse.yaml').code).toBe(2);
    expect(cadence(dir, 'spec', 'check').err).toMatch(/usage : cadence spec check/);
    expect(cadence(dir, 'spec', 'inconnu', 'x').code).toBe(2);
  });
});

describe('gabarit templates/fiche.yaml', () => {
  it('est un gabarit commenté qui passe cadence spec check tel quel', () => {
    const t = readFileSync(join(root, 'templates', 'fiche.yaml'), 'utf8');
    expect(t).toMatch(/^#/);
    expect(t).toMatch(/masque/);
    expect(cadence(tempDir(), 'spec', 'check', join(root, 'templates', 'fiche.yaml')).code).toBe(0);
  });

  it('ne renvoie qu\'à des références livrées avec le paquet (README), pas à docs/', () => {
    const t = readFileSync(join(root, 'templates', 'fiche.yaml'), 'utf8');
    expect(t).not.toMatch(/docs\/superpowers/);
    expect(t).not.toMatch(/dans le même dossier/);
    expect(t).toMatch(/README/);
  });
});

describe('design de l\'étape spec : la clé masque (note de revue L166)', () => {
  const design = readFileSync(join(root, 'docs', 'superpowers', 'specs', '2026-10-10-etape-spec-design.md'), 'utf8');
  it('figure au tableau du format de la fiche et dans la liste des invariants', () => {
    const regles = design.split('\n').find((l) => l.startsWith('| `regles[]`')) ?? '';
    expect(regles).toMatch(/`masque`/);
    const invariants = design.split('Invariants')[1]!.split('### 3.')[0]!;
    expect(invariants).toMatch(/`masque`[^.]*champ/);
  });
});

describe('citations en scalaire (revue L170)', () => {
  it('refuse une règle qui cite regles ou champs sans liste', () => {
    const f = fiche();
    f.actions[0].regles = 'R9';
    expect(checkFiche(f).join('\n')).toMatch(/A1 : regles doit être une liste/);
    const g = fiche();
    g.regles[0].champs = 'fantome';
    expect(checkFiche(g).join('\n')).toMatch(/R1 : champs doit être une liste/);
  });

  it('signale chaque entrée de liste qui n\'est pas du bon type au lieu de la filtrer', () => {
    for (const [liste, entree, attendu] of [
      ['champs', null, /champ n° 1 : objet attendu/],
      ['champs', 'seul', /champ n° 1 : objet attendu/],
      ['regles', null, /règle n° 1 : objet attendu/],
      ['regles', 'R1', /règle n° 1 : objet attendu/],
      ['actions', null, /action n° 4 : objet attendu/],
      ['actions', 'A4', /action n° 4 : objet attendu/],
      ['etats', { vide: 1 }, /état n° 5 : texte attendu/],
    ] as const) {
      const f = fiche();
      if (liste === 'champs' || liste === 'regles') f[liste][0] = entree;
      else f[liste].push(entree);
      expect(checkFiche(f).join('\n'), `${liste} ${String(entree)}`).toMatch(attendu);
    }
  });

  it('spec check sort en code 1 et spec qa ne plante pas sur une action vide', () => {
    const dir = tempDir();
    const f = fiche();
    f.actions.push(null);
    writeFileSync(join(dir, 'f.yaml'), JSON.stringify(f));
    expect(cadence(dir, 'spec', 'check', 'f.yaml').code).toBe(1);
    const qa = cadence(dir, 'spec', 'qa', 'f.yaml');
    expect(qa.code).toBe(1);
    expect(qa.err).toMatch(/action n° 4 : objet attendu/);
  });
});
