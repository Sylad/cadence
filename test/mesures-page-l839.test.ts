// L839 (demande D-34) : le mode script du ux-reviewer. `cadence mesures` mesure d'un coup, à chaque largeur, ce qu'une revue cherchait capture
// par capture : défilement horizontal et sa cause, textes tronqués, mots coupés, valeurs séparées de leur unité, libellés courts sur deux lignes,
// cibles sous 24 px. Page de test : test/fixtures/mesures/defauts.html, sept défauts connus (D1 à D7) ; propre.html n'en a aucun.
// La partie navigateur ne joue que si un Playwright est chargeable sur la machine (même recherche que les sondes) : sinon elle est sautée.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codeSortie, constatsGroupes, DEFAUTS, formater, lireEtat, lireOptions, main, mesurer, type Passe, type Rapport } from '../scripts/mesures-page.mjs';
import { banc, jetonsImage, jetonsTexte } from '../scripts/banc-ux-script.mjs';
import { outilsDe } from '../scripts/jetons-agents.mjs';
import { lancerNavigateur } from '../scripts/sondes-interaction.mjs';
import { sousTempDir } from './sondes-tmp-l778.js';
import { serveurSondes } from './sondes-serveur-l778.js';
import { tempDir } from './helpers.js';

const RACINE = join(import.meta.dirname, '..');
const page = (nom: string) => pathToFileURL(join(import.meta.dirname, 'fixtures', 'mesures', `${nom}.html`)).href;
const RAPIDE = { ...DEFAUTS, charge: 50, largeurs: [375, 1440], etats: [] };

const vide = (largeur: number, etat = 'base'): Passe => ({ etat, largeur, vue: largeur, document: largeur, defilementHorizontal: 0, motsLus: 10, plafondAtteint: false,
  reperes: [], debordements: [], tronques: [], coupures: [], separees: [], sautsDeLigne: [], cibles: [], polices: { min: 14, sous12: 0 } });
const rapport = (passes: Passe[]): Rapport => ({ url: 'u', hauteur: 900, date: 'd', passes, ecrituresCoupees: 0 });

describe('L839 — options de cadence mesures', () => {
  it('par défaut les quatre largeurs de la grille de livraison, aucun état demandé', () => {
    const o = lireOptions(['http://x/p']);
    expect(o.largeurs).toEqual([375, 768, 1024, 1440]);
    expect(o.etats).toEqual([]);
  });

  it('--largeurs et --etat (syntaxe des parcours des sondes), répétable', () => {
    const o = lireOptions(['file:///m.html', '--largeurs', '390, 1440', '--etat', 'légende → cliquer button.legende ; attendre 300', '--etat', 'menu → touche Tab']);
    expect(o.largeurs).toEqual([390, 1440]);
    expect(o.etats).toEqual([
      { nom: 'légende', etapes: [{ type: 'cliquer', sel: 'button.legende', n: 1 }, { type: 'attendre', ms: 300 }] },
      { nom: 'menu', etapes: [{ type: 'touche', touche: 'Tab' }] },
    ]);
  });

  it('refuse : sans URL, une largeur illisible ou trop petite, un état sans flèche, un nombre négatif', () => {
    expect(() => lireOptions([])).toThrow(/usage : cadence mesures/);
    expect(() => lireOptions(['x/p'])).toThrow(/usage/);
    expect(() => lireOptions(['http://x', '--largeurs', '375,abc'])).toThrow(/--largeurs/);
    expect(() => lireOptions(['http://x', '--largeurs', '100'])).toThrow(/--largeurs/);
    expect(() => lireEtat('sans flèche')).toThrow(/--etat « sans flèche »/);
    expect(() => lireOptions(['http://x', '--etat', 'p → glisser .a'])).toThrow(/étape illisible/);
    expect(() => lireOptions(['http://x', '--max', '-1'])).toThrow(/--max/);
  });
});

describe('L839 — compte rendu et code de sortie (sans navigateur)', () => {
  it('sans constat : code 0, « aucun constat »', () => {
    const r = rapport([vide(375), vide(1440)]);
    expect(codeSortie(r)).toBe(0);
    expect(formater(r)).toContain('aucun constat');
  });

  it('un même constat vu à deux largeurs fait UNE ligne qui dit où ; code 1', () => {
    const a = vide(375);
    const b = vide(1440);
    a.tronques = [{ sel: 'p.titre', visible: 120, contenu: 291, texte: 'Un titre' }];
    b.tronques = [{ sel: 'p.titre', visible: 120, contenu: 291, texte: 'Un titre' }];
    const r = rapport([a, b]);
    expect(codeSortie(r)).toBe(1);
    expect(constatsGroupes(r)).toHaveLength(1);
    const lignes = formater(r).split('\n').filter((l) => l.includes('✗'));
    expect(lignes).toEqual(['  ✗ texte tronqué — p.titre : 120 px visibles sur 291 « Un titre » — 375, 1440 px (base)']);
  });

  it('le défilement horizontal est un constat à lui seul, avec son maximum', () => {
    const a = vide(375);
    a.defilementHorizontal = 241;
    const r = rapport([a, vide(1440)]);
    expect(codeSortie(r)).toBe(1);
    expect(formater(r)).toContain('✗ défilement horizontal — jusqu\'à 241 px — 375 px (base)');
  });

  it('au-delà de --max groupes d\'une famille, la suite est comptée, pas listée', () => {
    const a = vide(375);
    a.cibles = Array.from({ length: 7 }, (_, i) => ({ sel: `a.c${i}`, largeur: 16, hauteur: 16, texte: '' }));
    const t = formater(rapport([a]), 2);
    expect(t.split('\n').filter((l) => l.includes('✗ cible'))).toHaveLength(2);
    expect(t).toContain('… 5 autre(s) « cible sous 24 × 24 px » (voir --json)');
  });

  it('une passe en erreur rend la passe « non vérifiée » (code 2), même avec des constats ailleurs ; aucune passe aussi', () => {
    const a = vide(375);
    a.defilementHorizontal = 10;
    const r = rapport([a, { etat: 'menu', largeur: 375, erreur: 'locator.click: Timeout 3000ms exceeded.' }]);
    expect(codeSortie(r)).toBe(2);
    expect(formater(r)).toContain('375 menu : non mesuré (locator.click: Timeout 3000ms exceeded.)');
    expect(formater(r)).toContain('1 passe(s) non mesurée(s) : non vérifié');
    expect(codeSortie(rapport([]))).toBe(2);
  });

  it('le plafond de mots lus se dit dans la ligne de chiffres', () => {
    const a = vide(375);
    a.plafondAtteint = true;
    expect(formater(rapport([a]))).toContain('plafond atteint : la suite n\'est pas lue');
  });

  it('usage illisible : code 2 sans lancer de navigateur', async () => {
    const err: string[] = [];
    expect(await main(['--largeurs'], { cwd: RACINE, env: {}, out: () => {}, err: (l) => err.push(l) })).toBe(2);
    expect(err[0]).toMatch(/^mesures : /);
  });
});

describe('L839 — banc réduit : jetons estimés (sans navigateur)', () => {
  it('une image suit la règle de l\'API : 1440 × 900 ramenée à 1,15 Mpx, 375 × 900 telle quelle', () => {
    expect(jetonsImage(375, 900)).toBe(450);
    expect(jetonsImage(1440, 900)).toBeGreaterThan(1500);
    expect(jetonsImage(1440, 900)).toBeLessThanOrEqual(1534);
    expect(jetonsTexte('abcd'.repeat(10))).toBe(10);
  });
});

describe('L839 — appels d\'outils d\'un sous-agent (jetons-agents)', () => {
  const rep = (id: string, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: {}, content } });
  it('chaque tool_use compte une fois, même répété sous le même message ; SubagentHandback et le texte ne comptent pas', () => {
    const t = [rep('m1', [{ type: 'tool_use', id: 'a', name: 'Bash' }]), rep('m1', [{ type: 'tool_use', id: 'a', name: 'Bash' }]),
      rep('m2', [{ type: 'tool_use', id: 'b', name: 'mcp__playwright__browser_snapshot' }, { type: 'text', text: 'x' }]),
      rep('m3', [{ type: 'tool_use', id: 'c', name: 'SubagentHandback' }]), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } })].join('\n');
    expect(outilsDe(t)).toBe(2);
    expect(outilsDe('')).toBe(0);
  });
});

describe('L839 — l\'agent et la doc décrivent le mode script', () => {
  const agent = readFileSync(join(RACINE, 'agents', 'ux-reviewer.md'), 'utf8');
  const doc = readFileSync(join(RACINE, 'docs', 'mesures-page.md'), 'utf8');
  const bancDoc = readFileSync(join(RACINE, 'docs', 'mesures', 'ux-mode-script-l839.md'), 'utf8');

  it('l\'agent : déclencheur, commande, pas d\'instantané, règle par famille, ligne de la liste', () => {
    expect(agent).toContain('## Script mode');
    expect(agent).toContain('Mode: script');
    expect(agent).toContain('cadence mesures <page url>');
    expect(agent).toMatch(/never call `browser_snapshot`/);
    for (const regle of ['WCAG 1.4.10', 'WCAG 2.5.8', 'Imprimerie nationale']) expect(agent).toContain(regle);
    expect(agent).toContain('mesures <page> : <p> passes, <k> constats, code <c>');
  });

  it('la doc donne la commande, les codes et les familles ; le banc donne la commande exacte des deux bras et la mesure', () => {
    expect(doc).toContain('cadence mesures <url>');
    for (const famille of ['défilement horizontal', 'texte tronqué', 'mot coupé', 'valeur séparée', 'libellé court', 'cible sous 24']) expect(doc).toContain(famille);
    expect(bancDoc).toContain('node scripts/banc-ux-script.mjs');
    expect(bancDoc).toContain('node scripts/jetons-agents.mjs --agent ux-reviewer');
    expect(bancDoc).toContain('Mode: script');
  });

  it('les scripts sont publiés avec le paquet, et la commande est dans l\'aide', () => {
    const files: string[] = JSON.parse(readFileSync(join(RACINE, 'package.json'), 'utf8')).files;
    for (const f of ['scripts/mesures-page.mjs', 'scripts/mesures-page-dom.mjs', 'docs/mesures-page.md']) expect(files).toContain(f);
    expect(readFileSync(join(RACINE, 'src', 'cli.ts'), 'utf8')).toContain('cadence mesures <url>');
    expect(readFileSync(join(RACINE, 'bin', 'cadence.js'), 'utf8')).toContain("tool === 'mesures'");
  });
});

const { rendu: lance } = await sousTempDir(() => lancerNavigateur(process.env, process.cwd()));
afterAll(async () => { await lance?.fermer(); });

describe.skipIf(!lance)('L839 — mesures sur des pages de test locales (navigateur réel)', () => {
  const nav = () => lance!.navigateur;

  it('les sept défauts connus sont retrouvés, chacun à la bonne largeur', async () => {
    const r = await mesurer(nav(), { ...RAPIDE, url: page('defauts') });
    const [p375, p1440] = r.passes;
    expect(p375!.defilementHorizontal).toBe(241); // D1 : bandeau de 600 px à 375 px (+16 de marge)
    expect(p375!.debordements!.map((d) => d.sel)).toEqual(['div[data-testid="bandeau"]']);
    expect(p1440!.defilementHorizontal).toBe(0); // le tableau large est dans son propre défileur : jamais un débordement
    expect(p1440!.debordements).toEqual([]);
    for (const p of r.passes) {
      expect(p.tronques!.map((d) => d.sel)).toEqual(['p.titre']); // D2
      expect(p.coupures!.map((d) => [d.sel, d.trait])).toEqual([['p.etroit', false]]); // D3
      expect(p.separees!.map((d) => [d.valeur, d.unite])).toEqual([['12', 'km/h']]); // D4
      expect(p.sautsDeLigne!.map((d) => [d.sel, d.lignes])).toEqual([['button.bouton', 2]]); // D5
      expect(p.cibles!.map((d) => d.sel)).toContain('button.petit'); // D6
      expect(p.polices).toEqual({ min: 10, sous12: 1 }); // D7
    }
    expect(codeSortie(r)).toBe(1);
  });

  it('la page propre : aucun constat à aucune largeur, code 0', async () => {
    const r = await mesurer(nav(), { ...RAPIDE, largeurs: [375, 768, 1024, 1440], url: page('propre') });
    expect(constatsGroupes(r)).toEqual([]);
    expect(codeSortie(r)).toBe(0);
  });

  it('un état demandé est mesuré après ses clics ; un sélecteur absent rend la passe non vérifiée', async () => {
    const etats = [lireEtat('panneau → cliquer #ouvrir'), lireEtat('absent → cliquer #nulle-part')];
    const r = await mesurer(nav(), { ...RAPIDE, largeurs: [375], url: page('defauts'), etats });
    const panneau = r.passes.find((p) => p.etat === 'panneau')!;
    expect(panneau.debordements!.map((d) => d.sel)).toContain('div#panneau');
    expect(r.passes.find((p) => p.etat === 'absent')!.erreur).toMatch(/click/);
    expect(codeSortie(r)).toBe(2);
  }, 30000);

  it('une requête qui écrit au chargement est coupée dans le navigateur, jamais reçue par le serveur', async () => {
    const pages = { '/ecrit.html': '<!doctype html><p>x</p><script>fetch("/api/ecrire", { method: "POST", body: "x" })</script>' };
    const srv = await serveurSondes(join(import.meta.dirname, 'fixtures', 'mesures'), pages);
    try {
      const r = await mesurer(nav(), { ...RAPIDE, largeurs: [375], charge: 300, url: `${srv.url}/ecrit.html` });
      expect(r.ecrituresCoupees).toBe(1);
      expect(srv.recu.http.filter((l) => !l.startsWith('GET'))).toEqual([]);
    } finally {
      await srv.fermer();
    }
  });

  it('cadence mesures écrit le JSON et les captures demandés, et rend le code des constats', async () => {
    const dossier = tempDir();
    const out: string[] = [];
    const code = await main([page('defauts'), '--largeurs', '375', '--charge', '50', '--json', join(dossier, 'm.json'), '--captures', join(dossier, 'cap')],
      { cwd: RACINE, env: process.env, out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(1);
    expect(JSON.parse(readFileSync(join(dossier, 'm.json'), 'utf8')).passes[0].largeur).toBe(375);
    expect(out.join('\n')).toContain(`capture 375 base : ${join(dossier, 'cap', 'mesures-base-375.png')}`);
  }, 30000);

  it('banc réduit : le mode script fait entrer moins de jetons que le plancher du mode actuel', async () => {
    const r = await banc(nav(), { ...RAPIDE, largeurs: [375, 768, 1024, 1440], url: page('defauts') });
    expect(r.script).toBeLessThan(r.actuel);
    expect(r.texte).toContain('constats :');
  }, 30000);
});
