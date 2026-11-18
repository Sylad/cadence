// L778 (demande D-14) : les sondes d'interaction trouvent ce qu'une revue d'écrans au repos ne voit pas. Pages de test locales :
// une liste qui saute (le défaut D-6 réduit à l'os) et la même qui ne saute pas, des dialogues bon et mauvais, un défilement subi.
// La partie navigateur ne joue que si un Playwright est chargeable sur la machine (même recherche que la commande) : sinon elle est sautée, et dit pourquoi.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cheminsPlaywright, codeSortie, essaisDeLancement, constatsClic, DEFAUTS, formater, lancerNavigateur, lireOptions, lireParcours, main, nonMesures, sonder, tousLesConstats, type Rapport } from '../scripts/sondes-interaction.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gardeDe } from '../scripts/sondes-garde.mjs';
import { serveurSondes } from './sondes-serveur-l778.js';
import { ENTETES_LARGE, essaiLarge, essaiMinimal, essaiPrudent } from './sondes-essais-r3-l778.js';

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
    controles: [{ id: '1', nom: 'Couche A', role: 'bascule', liste: true, mesure: { nonMesure: 'clic impossible : Timeout' }, constats: [] },
      { id: '2', nom: 'Couche B', role: 'bascule', liste: true, mesure: { sautMax: 0, sautFinal: 0, defilement: [], regions: null }, constats: [] }],
    parcours: [{ nom: 'p', pas: [{ etape: 'cliquer .x ×3', nonMesure: '1 élément(s) visible(s) pour 3 attendu(s)', constats: [] }] }] };

  it('nomme chaque clic non mesuré, et l\'en-tête dit la passe partielle', () => {
    expect(nonMesures(r)).toEqual(['« Couche A » — clic impossible : Timeout', 'parcours « p », cliquer .x ×3 — 1 élément(s) visible(s) pour 3 attendu(s)']);
    const t = formater(r);
    expect(t).toContain('2 clic(s) non mesuré(s)');
    expect(t).toContain('passe partielle');
    expect(t).toContain('  ? « Couche A » — clic impossible : Timeout');
    expect(codeSortie(r)).toBe(3);
  });

  it('revue r1 : sans aucun clic mesuré, ni « aucun constat » ni code 0 : « non mesurable », code 4', () => {
    const vide: Rapport = { ...r, controles: [], parcours: [], couverts: [{ nom: 'Couche A', role: 'bascule', liste: true }] };
    const t = formater(vide);
    expect(t).not.toContain('aucun constat');
    expect(t).toContain('aucun clic mesuré');
    expect(t).toContain('non mesurable');
    expect(nonMesures(vide)).toEqual(['« Couche A » — couvert par un autre élément à cette taille de vue : non mesurable']);
    expect(codeSortie(vide)).toBe(4);
    expect(codeSortie({ ...vide, couverts: [] })).toBe(4);
  });

  it('revue r1 : une écriture tentée par un clic est signalée et rend la passe partielle, même sans constat', () => {
    const e = { voie: 'websocket', cible: 'ws://h/socket', detail: 'DELETE item 1', ou: '« 🗑 » (bouton de liste)' };
    const w: Rapport = { ...r, parcours: [], ecrituresBloquees: 1, ecritures: [e],
      controles: [{ id: '1', nom: '🗑', role: 'bouton', liste: true, mesure: { sautMax: 0, sautFinal: 0, defilement: [], regions: null, ecritures: [e] }, constats: [] }] };
    const t = formater(w);
    expect(t).toContain('1 écriture(s) tentée(s), bloquée(s)');
    expect(t).toContain('  ! « 🗑 » (bouton de liste) : websocket ws://h/socket « DELETE item 1 »');
    expect(nonMesures(w)[0]).toContain('a tenté d\'écrire');
    expect(codeSortie(w)).toBe(3);
  });

  it('revue r1 : un bouton qui navigue est noté « navigue », ni constat ni non-mesuré', () => {
    const n: Rapport = { ...r, parcours: [], controles: [
      { id: '1', nom: 'Ouvrir', role: 'bouton', liste: true, mesure: { navigation: true, vers: 'file:///autre.html' }, constats: [] },
      { id: '2', nom: 'Option', role: 'bascule', liste: false, mesure: { sautMax: 0, sautFinal: 0, defilement: [], regions: null }, constats: [] }] };
    expect(formater(n)).toContain('1. « Ouvrir » (bouton) : navigue vers file:///autre.html (page rouverte)');
    expect(codeSortie(n)).toBe(0);
  });

  it('revue r1 : un navigateur relancé en rendu logiciel (GPU sans image) le dit dans l\'en-tête', () => {
    expect(formater({ ...r, rendu: 'logiciel' })).toContain('rendu logiciel (le GPU de la machine ne rendait aucune image) : WebGL coupé');
    expect(formater({ ...r, rendu: 'gpu' })).not.toContain('rendu logiciel');
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

  it('chaque chemin une fois : plusieurs processus du même serveur MCP, ou le cache qu\'il utilise, ne le font pas essayer deux fois', () => {
    const mcp = 'node /x/node_modules/.bin/playwright-mcp';
    expect(cheminsPlaywright({}, '/depot', [mcp, mcp, mcp], ['/x/node_modules/playwright', '/npx/a'])).toEqual(
      ['/depot/node_modules/playwright', '/x/node_modules/playwright', '/npx/a']);
  });

  it('le Chromium de chaque paquet d\'abord, puis le Chrome installé une seule fois (le même pour tous les paquets)', () => {
    expect(essaisDeLancement([{ chemin: 'a' }, { chemin: 'b' }, { chemin: 'c' }]).map((e) => `${e.chemin}:${e.opts.channel ?? 'chromium'}`))
      .toEqual(['a:chromium', 'b:chromium', 'c:chromium', 'a:chrome']);
    expect(essaisDeLancement([])).toEqual([]);
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
    expect(nonMesures(r)).toContain('« Sous le voile » — couvert par un autre élément à cette taille de vue : non mesurable');
  });

  it('défilement subi au repos : le fil qui défile seul est vu ; la page stable n\'en a pas', async () => {
    const r = await sonder(nav(), page('defile'), RAPIDE, []);
    expect(r.repos).toEqual([{ cible: 'div#fil', dx: 0, dy: 160 }]);
    expect((await sonder(nav(), page('stable'), { ...RAPIDE, sansBalayage: true }, [])).repos).toEqual([]);
  });
});

describe.skipIf(!lance)('L778 revue r1 — lecture seule, navigation, rien de mesuré, élément remplacé (navigateur réel)', () => {
  const nav = () => lance!.navigateur;
  const dossier = join(import.meta.dirname, 'fixtures', 'sondes');

  it('aucune écriture n\'atteint le serveur (WebSocket, fetch, XHR, balise, formulaire POST, WebRTC) ; chaque tentative est comptée et signalée', async () => {
    const srv = await serveurSondes(dossier);
    try {
      const r = await sonder(nav(), `${srv.url}/ecritures.html`, RAPIDE, []);
      expect(srv.recu.connexions).toBeGreaterThan(0); // la page a bien ouvert sa socket : la lecture passe
      expect(srv.recu.websocket).toEqual([]);
      expect(srv.recu.http.filter((l) => !l.startsWith('GET '))).toEqual([]);
      const voies = r.ecritures!.map((e) => e.voie);
      expect(voies).toContain('websocket');
      expect(voies).toContain('sendBeacon');
      expect(voies).toContain('RTCPeerConnection');
      expect(r.ecritures!.some((e) => e.voie === 'http' && e.detail.startsWith('POST'))).toBe(true);
      expect(r.ecritures!.some((e) => e.voie === 'http' && e.detail.startsWith('PUT'))).toBe(true);
      expect(r.ecritures!.find((e) => e.voie === 'websocket')).toMatchObject({ detail: 'DELETE item 1', ou: '« 🗑 » (bouton de liste)' });
      expect(r.ecrituresBloquees).toBe(r.ecritures!.length);
      const t = formater(r);
      expect(t).not.toMatch(/^aucun constat$/m);
      expect(t).toContain('a tenté d\'écrire');
      expect(codeSortie(r)).toBe(3);
    } finally {
      await srv.fermer();
    }
  });

  it('un bouton qui navigue par script : noté « navigue », page rouverte, la suite mesurée, code 0 et pas 1', async () => {
    const r = await sonder(nav(), page('navigue'), RAPIDE, []);
    const [ouvrir, voir, option] = r.controles;
    expect(ouvrir!.mesure).toMatchObject({ navigation: true });
    expect(ouvrir!.mesure.vers).toContain('autre.html');
    expect(voir!.mesure).toMatchObject({ navigation: true });
    expect(option!.mesure.sautMax).toBe(0);
    expect(codeSortie(r)).toBe(0);
    const lignes: string[] = [];
    const code = await main([page('navigue'), '--charge', '200', '--repos', '300', '--attente', '400'], { cwd: dossier, env: process.env, out: (l) => lignes.push(l), err: (l) => lignes.push(l) });
    expect(lignes.join('\n')).toContain('navigue vers');
    expect(code).toBe(0);
  });

  it('tout est couvert : 0 clic mesuré, les couverts sont nommés, code 4', async () => {
    const r = await sonder(nav(), page('tout-couvert'), RAPIDE, []);
    expect(r.controles).toEqual([]);
    expect(r.couverts!.map((c) => c.nom)).toEqual(['Couche A', 'Couche B']);
    expect(formater(r)).not.toContain('aucun constat');
    expect(codeSortie(r)).toBe(4);
  });

  it('un élément remplacé par le clic est suivi par son équivalent : le saut de la liste reconstruite est vu', async () => {
    const r = await sonder(nav(), page('remplace'), RAPIDE, []);
    const [c] = r.controles;
    expect(c!.mesure.remplace).toBe(true);
    expect(c!.constats.filter((k) => k.type === 'saut').length).toBe(2); // au clic et au retour : l'équivalent est remis
    expect(c!.retour?.remplace).toBe(true);
    expect(codeSortie(r)).toBe(1);
  });

  it('un élément remplacé sans équivalent unique est non mesurable, jamais un saut nul', async () => {
    const r = await sonder(nav(), page('remplace-perdu'), RAPIDE, []);
    const [c] = r.controles;
    expect(c!.mesure.nonMesure).toMatch(/remplacé par le clic.*2 équivalent/);
    expect(c!.constats).toEqual([]);
    expect(codeSortie(r)).toBe(4);
  });
});

describe('L778 revue r2 — le rapport ne dit que ce que la lecture seule couvre', () => {
  const r: Rapport = { url: 'u', largeur: 390, hauteur: 844, seuil: 1, date: 'd', repos: [], ecrituresBloquees: 0, controles: [], parcours: [],
    workers: [{ type: 'worker', url: 'http://h/w.js' }, { type: 'shared_worker', url: 'http://h/s.js' }] };

  it('n\'affirme plus « rien n\'a atteint le serveur » ; dit les voies coupées, les workers gardés et ce qui n\'est pas couvert', () => {
    const e = { voie: 'http', cible: 'http://h/x', detail: 'POST http://h/x', ou: '« x » (bouton de liste)' };
    const t = formater({ ...r, ecrituresBloquees: 1, ecritures: [e] });
    expect(t).not.toContain('rien n\'a atteint le serveur');
    expect(t).toContain('coupée(s) dans le navigateur avant d\'en sortir : 1');
    expect(t).toContain('Worker(s) dédié(s) gardé(s) : 1'); // revue r3 : un SharedWorker n'est plus « gardé », son constructeur est retiré de la page
    expect(t).toContain('non couvert : un GET qui écrit côté serveur');
  });

  it('une cible qu\'on n\'a pas pu garder rend la passe non vérifiée (code 2), même avec des constats', () => {
    const k = { id: '1', nom: 'A', role: 'bascule' as const, liste: true, mesure: { sautMax: 40, sautFinal: 40, defilement: [], regions: null }, constats: [{ type: 'saut' as const, valeur: 40, texte: 'saut' }] };
    const n: Rapport = { ...r, controles: [k], nonGardes: ['shared_worker http://h/s.js : Runtime.evaluate : refus'] };
    expect(codeSortie(n)).toBe(2);
    expect(formater(n)).toContain('cible non gardée, ses écritures n\'ont pas été coupées : shared_worker http://h/s.js : Runtime.evaluate : refus — passe non vérifiée');
  });

  it('la doc, le changelog et les agents n\'affirment pas une coupure totale et nomment ce qui n\'est pas couvert', () => {
    const lire = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    for (const f of ['docs/sondes-interaction.md', 'changelog.d/L778.md', 'agents/qa-reviewer.md', 'agents/ux-reviewer.md', 'scripts/sondes-interaction.mjs']) {
      const t = lire(f);
      expect(t, f).not.toMatch(/rien n'a atteint le serveur|every way the browser (can )?writes?|cut every way|every way the browser writes is cut/i);
    }
    const doc = lire('docs/sondes-interaction.md');
    expect(doc).toContain('SharedWorker');
    expect(doc).toMatch(/not covered/i);
    for (const f of ['changelog.d/L778.md', 'agents/qa-reviewer.md', 'agents/ux-reviewer.md']) expect(lire(f), f).toMatch(/GET that writes|not covered/i);
  });
});

describe.skipIf(!lance)('L778 revue r2 — workers dédiés, partagés, module et blob : rien n\'atteint le serveur (navigateur réel)', () => {
  const dossier = join(import.meta.dirname, 'fixtures', 'sondes');

  // Revue r3 : le SharedWorker de la page n'est plus « gardé » (il écrivait encore) : son constructeur est retiré, il ne démarre pas, le bouton « y » n'a plus rien à écrire.
  it('l\'essai du relecteur : POST et ws.send depuis Worker, worker module, worker blob et worker qui garde les natives : rien n\'est reçu ; le SharedWorker ne démarre pas', async () => {
    const srv = await serveurSondes(dossier);
    try {
      const r = await sonder(lance!.navigateur, `${srv.url}/workers.html`, { ...RAPIDE, parListe: 6, charge: 600 }, []);
      expect(srv.recu.connexions).toBeGreaterThanOrEqual(4); // chaque Worker dédié a ouvert sa socket : la lecture passe
      expect(srv.recu.http.filter((l) => !l.startsWith('GET '))).toEqual([]);
      expect(srv.recu.websocket).toEqual([]);
      const de = (nom: string) => r.ecritures!.filter((e) => e.ou === `« ${nom} » (bouton de liste)`).map((e) => `${e.voie} ${e.detail}`);
      expect(de('x')).toEqual(expect.arrayContaining(['websocket WORKER DELETE', expect.stringMatching(/^http POST .*\/worker-post$/)]));
      expect(de('y')).toEqual([]);
      expect(srv.recu.http.filter((l) => l.includes('nom=SHARED'))).toEqual([]); // le script du SharedWorker n'a jamais été demandé
      expect(r.coupees).toEqual([{ nom: 'SharedWorker', fois: 1 }]);
      expect(de('m')).toEqual(expect.arrayContaining(['websocket MODULE DELETE', expect.stringMatching(/^http POST .*\/module-post$/)]));
      expect(de('b')).toEqual(expect.arrayContaining(['websocket BLOB DELETE', expect.stringMatching(/^http POST .*\/blob-post$/)]));
      expect(de('c')).toEqual(expect.arrayContaining(['websocket CAPTURE DELETE', 'WebTransport bloqué']));
      expect(r.workers!.map((w) => w.type)).toEqual(['worker', 'worker', 'worker', 'worker']);
      expect(r.nonGardes).toEqual([]);
      expect(r.fenetres).toEqual([]); // revue r4 : chaque page, popup et iframe de l'essai a prouvé le script d'initialisation
      for (const c of r.controles) expect(nonMesures(r).some((m) => m.startsWith(`« ${c.nom} » — le clic a tenté d'écrire`)), c.nom).toBe(c.nom !== 'y');
      expect(codeSortie(r)).toBe(3);
    } finally {
      await srv.fermer();
    }
  });

  it('sans garde (navigateur lancé sans port de débogage), rien n\'est sondé', async () => {
    const pw = createRequire(join(lance!.chemin, 'package.json'))(lance!.chemin);
    const nu = await pw.chromium.launch({ headless: true });
    try {
      expect(gardeDe(nu)).toBeUndefined();
      await expect(sonder(nu, page('stable'), RAPIDE, [])).rejects.toThrow(/garde de lecture seule absente/);
    } finally {
      await nu.close();
    }
  });
});

describe('L778 revue r3 — fonctions retirées de la page : le rapport les nomme et ne dit que ce qui est mesuré', () => {
  const r: Rapport = { url: 'u', largeur: 390, hauteur: 844, seuil: 1, date: 'd', repos: [], ecrituresBloquees: 0, controles: [], parcours: [],
    workers: [{ type: 'worker', url: 'http://h/w.js' }] };

  it('une fonction retirée que la page a demandée est dite « fonction coupée pendant la sonde : <nom> », avec le compte', () => {
    const t = formater({ ...r, coupees: [{ nom: 'SharedWorker', fois: 2 }, { nom: 'navigator.serviceWorker.register', fois: 1 }] });
    expect(t).toContain('fonction coupée pendant la sonde : SharedWorker (demandée 2 fois par la page ou un iframe ; un test de présence compte)');
    expect(t).toContain('fonction coupée pendant la sonde : navigator.serviceWorker.register (demandée 1 fois');
    expect(formater(r)).not.toContain('fonction coupée pendant la sonde');
  });

  it('une erreur de la page sur une fonction coupée rend la passe partielle (code 3), jamais « aucun constat » tout court', () => {
    const k = { id: '1', nom: 'x', role: 'bouton' as const, liste: true, mesure: { sautMax: 0, sautFinal: 0, defilement: [], regions: null }, constats: [] };
    expect(codeSortie({ ...r, controles: [k] })).toBe(0);
    const e: Rapport = { ...r, controles: [k], coupees: [{ nom: 'SharedWorker', fois: 1 }], erreursCoupees: ['SharedWorker is not a constructor'] };
    expect(codeSortie(e)).toBe(3);
    const t = formater(e);
    expect(t).not.toMatch(/^aucun constat$/m);
    expect(t).toContain('passe partielle : la page a levé une erreur sur une fonction coupée');
    expect(t).toContain('  ? erreur de la page sur une fonction coupée : SharedWorker is not a constructor');
  });

  it('la ligne « lecture seule » nomme les fonctions retirées, ne compte que les Workers dédiés, et dit WebTransport réel non couvert', () => {
    const t = formater(r);
    expect(t).toContain('retirés de la page et de chaque iframe avant tout script : SharedWorker, WebSocketStream, WebTransport, navigator.serviceWorker.register');
    expect(t).toContain('Worker(s) dédié(s) gardé(s) : 1');
    expect(t).toMatch(/non couvert : un GET qui écrit côté serveur ; WebTransport réel \(aucun serveur HTTP\/3/);
    expect(t).not.toMatch(/workers : avant leur démarrage|shared_worker/);
  });

  it('un SharedWorker ou un service worker qui démarre quand même, ou une fonction non retirée, rend la passe non vérifiée (code 2)', () => {
    const n: Rapport = { ...r, nonGardes: ['shared_worker http://h/s.js : démarré alors que SharedWorker est retiré de la page'] };
    expect(codeSortie(n)).toBe(2);
    expect(formater(n)).toContain('✗ cible non gardée');
  });

  it('la doc, le changelog et les agents ne promettent plus « every worker » ni « paused at its start » pour un SharedWorker, et nomment WebTransport réel', () => {
    const lire = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    for (const f of ['docs/sondes-interaction.md', 'changelog.d/L778.md', 'agents/qa-reviewer.md', 'agents/ux-reviewer.md']) {
      const t = lire(f).replace(/\s+/g, ' ');
      expect(t, f).not.toMatch(/every worker|no message reaches the server|shared, module and blob workers\)/i);
      expect(t, f).toMatch(/SharedWorker/);
      expect(t, f).toMatch(/removed/i);
      expect(t, f).toMatch(/not covered:?\*{0,2} [^.]*WebTransport/i);
      expect(t, f).toContain('fonction coupée pendant la sonde');
    }
    expect(lire('docs/sondes-interaction.md')).toMatch(/HTTP\/3/);
  });
});

describe.skipIf(!lance)('L778 revue r3 — les deux essais du relecteur rejoués : aucune écriture reçue, SharedWorker compris (navigateur réel)', () => {
  const dossier = join(import.meta.dirname, 'fixtures', 'sondes');
  const ESSAI = { ...DEFAUTS, charge: 1500, repos: 500, attente: 800 };
  const ecrits = (http: string[]) => http.filter((l) => !/^(GET|HEAD|OPTIONS) /.test(l));
  const rapports = (http: string[]) => http.filter((l) => l.startsWith('GET /report?')).map((l) => decodeURIComponent(l.slice('GET /report?'.length)));
  const coupees = (r: Rapport) => (r.coupees ?? []).map((c) => c.nom);

  it('essai minimal (exp3/run2.mjs) : ni « SHARED DELETE NATIF » ni « PAGE STREAM DELETE » ; le SharedWorker ne démarre pas, le rapport le dit', async () => {
    const srv = await serveurSondes(dossier, essaiMinimal());
    try {
      const r = await sonder(lance!.navigateur, `${srv.url}/p.html`, ESSAI, []);
      expect(srv.recu.websocket).toEqual([]);
      expect(ecrits(srv.recu.http)).toEqual([]);
      expect(srv.recu.http.filter((l) => /\/(shared|sw)\.js/.test(l))).toEqual([]); // ni le SharedWorker ni le service worker n'ont été chargés
      expect(srv.recu.connexions).toBe(0);
      expect(coupees(r)).toContain('SharedWorker');
      expect(formater(r)).toContain('fonction coupée pendant la sonde : SharedWorker');
      // la page ne teste pas SharedWorker : son script lève à sa première ligne, ses boutons sont morts. Le rapport le dit, la passe est partielle.
      expect(r.erreursCoupees).toEqual(['SharedWorker is not a constructor']);
      expect(formater(r)).not.toMatch(/^aucun constat$/m);
      expect(codeSortie(r)).toBe(3);
      expect(r.workers).toEqual([]);
      expect(r.nonGardes).toEqual([]);
      expect(r.fenetres).toEqual([]); // revue r4 : chaque page, popup et iframe de l'essai a prouvé le script d'initialisation
    } finally {
      await srv.fermer();
    }
  });

  it('la même app, prudente (elle teste chaque fonction) : boutons vivants, chaque fonction retirée est absente dans la page, un iframe et un popup neufs', async () => {
    const srv = await serveurSondes(dossier, essaiPrudent());
    try {
      const r = await sonder(lance!.navigateur, `${srv.url}/p.html`, ESSAI, []);
      expect(srv.recu.websocket).toEqual([]);
      expect(ecrits(srv.recu.http)).toEqual([]);
      expect(srv.recu.http.filter((l) => /\/(shared|sw)\.js/.test(l))).toEqual([]);
      const vus = rapports(srv.recu.http);
      expect(vus).toEqual(expect.arrayContaining(['shared=absent', 'clic-shared=undefined', 'wsstream=absent', 'sw=refuse']));
      for (const nom of ['iframe', 'popup']) for (const k of ['SharedWorker', 'WebSocketStream', 'WebTransport']) expect(vus, `${nom}.${k}`).toContain(`${nom}.${k}=absent`);
      expect(vus.filter((v) => /PRESENT|CONSTRUIT|ENREGISTRE/.test(v))).toEqual([]);
      expect(coupees(r)).toEqual(expect.arrayContaining(['SharedWorker', 'WebSocketStream', 'WebTransport', 'navigator.serviceWorker.register']));
      expect(r.controles.map((c) => c.mesure.sautMax)).toEqual([0, 0, 0]); // les trois boutons sont pressés et mesurés
      expect(r.erreursCoupees).toEqual([]); // elle teste avant de s'en servir : rien ne lève
      expect(r.nonGardes).toEqual([]);
      expect(r.fenetres).toEqual([]); // revue r4 : chaque page, popup et iframe de l'essai a prouvé le script d'initialisation
    } finally {
      await srv.fermer();
    }
  });

  it('essai large (exp3/run.mjs) : page, 4 sortes d\'iframe, popup, Workers de toute sorte, SharedWorker, service worker, ping, formulaire, CSP : rien n\'est reçu', async () => {
    const srv = await serveurSondes(dossier, essaiLarge(), ENTETES_LARGE);
    try {
      const r = await sonder(lance!.navigateur, `${srv.url}/p.html`, ESSAI, []);
      expect(srv.recu.websocket).toEqual([]); // r3 : 31 messages reçus
      expect(ecrits(srv.recu.http)).toEqual([]);
      expect(srv.recu.connexions).toBeGreaterThan(10); // page, iframes et Workers dédiés ont ouvert leur socket : la lecture passe
      expect(srv.recu.http.filter((l) => /\/sw\.js|w\.js\?partage|parent\.js\?p(charge|clic)/.test(l))).toEqual([]); // aucun SharedWorker, aucun service worker chargé
      const vus = rapports(srv.recu.http);
      expect(vus.filter((v) => /CONSTRUIT|PASSE|ENREGISTRE|=true/.test(v))).toEqual([]);
      expect(vus).toEqual(expect.arrayContaining(['partage=refuse', 'sw=refuse', 'page-charge.wsstream=absent', 'page-charge.wt=absent', 'page-clic.wsstream=absent',
        'iframeblanc-charge.wsstream=absent', 'iframesrc-charge.wsstream=absent', 'iframesrcdoc-charge.wsstream=absent', 'iframeblanc-clic.wt=absent',
        'dedie-charge.wsstream-debut=leve', 'dedie-charge.wt-debut=leve', 'module-charge.wsstream-debut=leve', 'blob-charge.wsstream-debut=leve',
        'petit-fils-charge.wsstream-debut=leve', 'de-enfant-charge.wt-debut=leve', 'dedie-charge.wsstream-message=leve']));
      expect(vus.filter((v) => /^partage/.test(v) && v !== 'partage=refuse')).toEqual([]); // aucun SharedWorker n'a tourné
      expect(vus.filter((v) => /^rafale\d+-charge\.wsstream-debut=leve$/.test(v)).length).toBeGreaterThanOrEqual(12); // 12 par chargement de la page
      expect(coupees(r)).toEqual(expect.arrayContaining(['SharedWorker', 'WebSocketStream', 'WebTransport', 'navigator.serviceWorker.register']));
      expect(r.workers!.every((w) => w.type === 'worker')).toBe(true);
      expect(r.workers!.length).toBeGreaterThanOrEqual(30);
      expect(r.nonGardes).toEqual([]);
      expect(r.fenetres).toEqual([]); // revue r4 : chaque page, popup et iframe de l'essai a prouvé le script d'initialisation
      const voies = new Set(r.ecritures!.map((e) => e.voie));
      for (const v of ['http', 'websocket', 'sendBeacon', 'WebSocketStream', 'WebTransport']) expect(voies, v).toContain(v);
    } finally {
      await srv.fermer();
    }
  }, 120_000);
});
