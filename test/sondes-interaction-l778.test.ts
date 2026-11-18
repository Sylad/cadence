// L778 (demande D-14) : les sondes d'interaction trouvent ce qu'une revue d'écrans au repos ne voit pas. Pages de test locales :
// une liste qui saute (le défaut D-6 réduit à l'os) et la même qui ne saute pas, des dialogues bon et mauvais, un défilement subi.
// La partie navigateur ne joue que si un Playwright est chargeable sur la machine (même recherche que la commande) : sinon elle est sautée, et dit pourquoi.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cheminsPlaywright, constatsClic, DEFAUTS, formater, lancerNavigateur, lireOptions, lireParcours, nonMesures, sonder, tousLesConstats, type Rapport } from '../scripts/sondes-interaction.mjs';

const page = (nom: string) => pathToFileURL(join(import.meta.dirname, 'fixtures', 'sondes', `${nom}.html`)).href;
const RAPIDE = { ...DEFAUTS, charge: 200, repos: 1500, attente: 400 };

describe('L778 — parcours lus dans docs/qa/expectations.md', () => {
  const attendus = [
    '# QA expectations', '', '## /map', 'shows: la carte', 'parcours: cocher 3 couches voisines → cliquer `label.layer-toggle input` ×3',
    '- parcours: ouvrir puis fermer la légende → cliquer button.legend ; attendre 300 ; touche Escape', '', '## /autre', 'parcours: rien → cliquer a',
  ].join('\n');

  it('rend les parcours de la seule section de la route, étapes comprises', () => {
    expect(lireParcours(attendus, '/map')).toEqual([
      { nom: 'cocher 3 couches voisines', etapes: [{ type: 'cliquer', sel: 'label.layer-toggle input', n: 3 }] },
      { nom: 'ouvrir puis fermer la légende', etapes: [{ type: 'cliquer', sel: 'button.legend', n: 1 }, { type: 'attendre', ms: 300 }, { type: 'touche', touche: 'Escape' }] },
    ]);
    expect(lireParcours(attendus, '/absente')).toEqual([]);
  });

  it('une étape illisible est refusée et citée', () => {
    expect(() => lireParcours('## /x\nparcours: p → glisser .a', '/x')).toThrow(/étape illisible « glisser \.a »/);
  });
});

describe('L778 — constats d\'une mesure (sans navigateur)', () => {
  it('0 px ne fait aucun constat ; au-delà du seuil, le saut nomme la région changée au-dessus', () => {
    expect(constatsClic({ sautMax: 0.4, sautFinal: 0, defilement: [], regions: null, dialogue: null }, 1)).toEqual([]);
    const k = constatsClic({ sautMax: 140.3, sautFinal: 140.3, defilement: [], regions: { proche: { distance: 7, cote: 'en dessous', region: 'input.x', texte: '' }, dessus: { distance: 12, cote: 'au-dessus', region: 'div.actives', texte: 'Active : a' }, horsVue: false, nombre: 2 } }, 1);
    expect(k).toHaveLength(1);
    expect(k[0].texte).toContain('saut de 140 px');
    expect(k[0].texte).toContain('div.actives « Active : a »');
  });

  it('dialogue sans focus, Échap qui ne ferme pas, défilement subi et effet hors de vue sont des constats', () => {
    const k = constatsClic({ sautMax: 0, sautFinal: 0, defilement: [{ cible: 'div#fil', dx: 0, dy: 160 }], regions: { proche: null, dessus: null, horsVue: true, nombre: 1 }, dialogue: { nom: 'D', focusDedans: false }, echap: { ferme: false, focusRendu: false } }, 1);
    expect(k.map((x) => x.type)).toEqual(['defilement', 'hors-vue', 'focus', 'echap']);
  });
});

describe('L778 — une passe partielle ne se lit jamais « aucun constat »', () => {
  const r: Rapport = { url: 'u', largeur: 390, hauteur: 844, seuil: 1, date: 'd', repos: [], ecrituresBloquees: 0,
    controles: [{ id: '1', nom: 'Couche A', role: 'bascule', liste: true, mesure: { nonMesure: 'clic impossible : Timeout' }, constats: [] }],
    parcours: [{ nom: 'p', pas: [{ etape: 'cliquer .x ×3', nonMesure: '1 élément(s) visible(s) pour 3 attendu(s)', constats: [] }] }] };

  it('nomme chaque clic non mesuré, et l\'en-tête dit la passe partielle', () => {
    expect(nonMesures(r)).toEqual(['« Couche A » — clic impossible : Timeout', 'parcours « p », cliquer .x ×3 — 1 élément(s) visible(s) pour 3 attendu(s)']);
    const t = formater(r);
    expect(t).toContain('2 clic(s) non mesuré(s)');
    expect(t).toContain('passe partielle');
    expect(t).toContain('  ? « Couche A » — clic impossible : Timeout');
  });
});

describe('L778 — options et recherche de Playwright', () => {
  it('lit les nombres, refuse une URL absente ou un nombre faux', () => {
    expect(lireOptions(['https://a.b/map', '--seuil', '2', '--par-liste', '5'])).toMatchObject({ url: 'https://a.b/map', seuil: 2, parListe: 5, max: DEFAUTS.max });
    expect(() => lireOptions([])).toThrow(/usage/);
    expect(() => lireOptions(['https://a.b', '--seuil', 'x'])).toThrow(/--seuil/);
  });

  it('cherche dans l\'ordre : CADENCE_PLAYWRIGHT, node_modules du dépôt, serveur MCP en cours, cache npx', () => {
    expect(cheminsPlaywright({ CADENCE_PLAYWRIGHT: '/pw' }, '/depot', ['node /x/node_modules/.bin/playwright-mcp'], ['/npx/a'])).toEqual(
      ['/pw', '/depot/node_modules/playwright', '/x/node_modules/playwright', '/npx/a']);
  });
});

const lance = await lancerNavigateur(process.env, process.cwd());
afterAll(async () => { await lance?.fermer(); });

describe.skipIf(!lance)('L778 — sondes jouées sur des pages de test locales (navigateur réel)', () => {
  const nav = () => lance!.navigateur;

  it('la liste qui saute : chaque case cochée saute d\'une ligne, au clic et au retour, et la cause est au-dessus', async () => {
    const r = await sonder(nav(), page('saute'), RAPIDE, []);
    const sauts = tousLesConstats(r).filter((k) => k.type === 'saut');
    expect(r.controles.length).toBe(3); // 3 par liste au plus
    expect(sauts.length).toBe(6);
    for (const k of sauts) expect(k.valeur).toBeGreaterThanOrEqual(20);
    expect(r.controles[0]!.mesure.regions?.dessus?.texte).toContain('Active : a');
  });

  it('la liste stable : 0 px pour chaque case, aucun constat, la région changée est en dessous', async () => {
    const r = await sonder(nav(), page('stable'), RAPIDE, []);
    expect(r.controles.length).toBe(3);
    for (const c of r.controles) expect(c.mesure.sautMax).toBe(0);
    expect(tousLesConstats(r)).toEqual([]);
    expect(r.controles[0]!.mesure.regions?.proche?.cote).toBe('en dessous');
  });

  it('un parcours déclaré joue les mêmes sondes : 3 cases voisines cochées, 3 sauts', async () => {
    const parcours = lireParcours('## /p\nparcours: cocher 3 couches voisines → cliquer #couches input ×3', '/p');
    const r = await sonder(nav(), page('saute'), { ...RAPIDE, sansBalayage: true }, parcours);
    expect(r.controles).toEqual([]);
    expect(r.parcours[0]!.pas.map((s) => s.constats.map((k) => k.type))).toEqual([['saut'], ['saut'], ['saut']]);
  });

  it('dialogues : le bon porte le focus et se ferme par Échap, le mauvais fait deux constats', async () => {
    const r = await sonder(nav(), page('dialogues'), RAPIDE, []);
    const bon = r.controles.find((c) => c.nom === 'Détails bons')!;
    const mauvais = r.controles.find((c) => c.nom === 'Détails mauvais')!;
    expect(bon.mesure.dialogue?.focusDedans).toBe(true);
    expect(bon.mesure.echap).toEqual({ ferme: true, focusRendu: true });
    expect(bon.constats).toEqual([]);
    expect(mauvais.constats.map((k) => k.type)).toEqual(['focus', 'echap']);
  });

  it('un contrôle couvert par un autre élément n\'est pas retenu ; un parcours qui en demande plus qu\'il n\'y en a le dit', async () => {
    const parcours = lireParcours('## /c\nparcours: trois cases → cliquer #liste input ×3', '/c');
    const r = await sonder(nav(), page('couvert'), RAPIDE, parcours);
    expect(r.controles.map((c) => c.nom)).toEqual(['Découverte']);
    expect(nonMesures(r).some((m) => m.includes('pour 3 attendu(s)'))).toBe(true);
  });

  it('défilement subi au repos : le fil qui défile seul est vu ; la page stable n\'en a pas', async () => {
    const r = await sonder(nav(), page('defile'), RAPIDE, []);
    expect(r.repos).toEqual([{ cible: 'div#fil', dx: 0, dy: 160 }]);
    expect((await sonder(nav(), page('stable'), { ...RAPIDE, sansBalayage: true }, [])).repos).toEqual([]);
  });
});
