// Sondes d'interaction (L778, demande D-14) : ce qu'une revue d'écrans au repos ne voit pas. Pour chaque case, bascule ou bouton d'une liste d'une
// page : le saut vertical de l'élément cliqué, la région qui a changé et sa distance, le défilement subi sans geste, le focus à l'ouverture d'un
// dialogue et Échap qui le ferme ; puis les parcours propres au projet, déclarés dans docs/qa/expectations.md (lignes `parcours:`).
// Générique : rien de propre à un projet. Lancé par `cadence sondes <url>` (bin/cadence.js) ; le ux-reviewer et le qa-reviewer le jouent.
// Playwright n'est pas une dépendance du paquet : il est pris sur la machine, dans l'ordre du qa-reviewer, et rien n'est jamais installé.
// La page reçoit le code de scripts/sondes-page.mjs. Méthode, seuils et format : docs/sondes-interaction.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ARG_DEBOGAGE, armerGarde, couperLesEcritures, gardeDe, lectureSeule } from './sondes-garde.mjs';
import { SCRIPT_SONDES } from './sondes-page.mjs';

/** Les seuils par défaut, documentés dans docs/sondes-interaction.md#thresholds. */
export const DEFAUTS = Object.freeze({ seuil: 1, max: 30, parListe: 3, attente: 1000, charge: 5000, repos: 3000, largeur: 1440, hauteur: 900 });

const USAGE = 'usage : cadence sondes <url> [--largeur 1440] [--hauteur 900] [--seuil 1] [--max 30] [--par-liste 3] [--attente 1000] [--charge 5000] '
  + '[--repos 3000] [--attendus docs/qa/expectations.md] [--route /chemin] [--sans-balayage] [--json fichier] [--captures dossier]';

const ETAPE = /^(cliquer|touche|attendre)\s+(.+?)(?:\s+[×x](\d+))?$/;

/**
 * Les parcours d'une route dans un fichier d'attendus : les lignes `parcours: <nom> → <étape> ; <étape> …` de sa section `## <route>`.
 * Étapes : `cliquer <sélecteur CSS> [×N]` (les N premiers éléments visibles, voisins dans l'ordre du document, cliqués un à un et mesurés),
 * `touche <touche>` (Escape, Tab…), `attendre <ms>`. Une étape inconnue lève une erreur qui cite la ligne.
 */
export function lireParcours(texte, route) {
  const out = [];
  let dedans = false;
  for (const brute of texte.split('\n')) {
    const titre = /^##\s+(.+?)\s*$/.exec(brute);
    if (titre) { dedans = titre[1].replace(/`/g, '') === route; continue; }
    const m = /^\s*(?:[-*]\s+)?parcours:\s*(.+?)\s*→\s*(.+)$/.exec(brute);
    if (!dedans || !m) continue;
    const etapes = m[2].split(';').map((e) => e.trim().replace(/`/g, '')).filter(Boolean).map((e) => {
      const p = ETAPE.exec(e);
      if (!p) throw new Error(`parcours « ${m[1]} » : étape illisible « ${e} » (attendu : cliquer <sélecteur> [×N], touche <touche>, attendre <ms>)`);
      if (p[1] === 'cliquer') return { type: 'cliquer', sel: p[2], n: p[3] ? Number(p[3]) : 1 };
      if (p[1] === 'attendre') return { type: 'attendre', ms: Number(p[2]) || 0 };
      return { type: 'touche', touche: p[2] };
    });
    out.push({ nom: m[1], etapes });
  }
  return out;
}

/**
 * Où chercher Playwright, dans l'ordre : CADENCE_PLAYWRIGHT, le node_modules du dépôt, le serveur MCP Playwright en cours, le cache npx le plus récent.
 * Chaque chemin une fois (plusieurs processus du même serveur MCP le citaient chacun).
 */
export function cheminsPlaywright(env, cwd, processus, caches) {
  const out = [];
  if (env.CADENCE_PLAYWRIGHT) out.push(env.CADENCE_PLAYWRIGHT);
  out.push(join(cwd, 'node_modules', 'playwright'));
  for (const ligne of processus) {
    const m = /(\S+)\/node_modules\/\.bin\/playwright-mcp/.exec(ligne);
    if (m) out.push(join(m[1], 'node_modules', 'playwright'));
  }
  return [...new Set([...out, ...caches])];
}

function cachesNpx(home) {
  const dir = join(home, '.npm', '_npx');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((d) => join(dir, d, 'node_modules', 'playwright')).filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function processus() {
  try { return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n'); } catch { return []; }
}

/** Le navigateur affiche-t-il des images ? Sans `requestAnimationFrame`, aucun clic n'aboutit (Playwright attend un élément stable) ni aucun saut ne se suit. */
async function afficheDesImages(navigateur) {
  const page = await navigateur.newPage();
  try {
    return await page.evaluate(() => new Promise((ok) => {
      let k = 0;
      const f = () => { k += 1; if (k >= 3) ok(true); else requestAnimationFrame(f); };
      requestAnimationFrame(f);
      setTimeout(() => ok(false), 2000);
    }));
  } finally {
    await page.close();
  }
}

/**
 * Les lancements essayés : rendu par le GPU d'abord, puis rendu logiciel (`--use-gl=disabled`) quand le GPU de la machine ne rend aucune image.
 * Chacun ouvre le port de débogage (127.0.0.1, port libre) par lequel la garde de lecture seule parle au navigateur (scripts/sondes-garde.mjs).
 */
const LANCEMENTS = [{ rendu: 'gpu', args: [ARG_DEBOGAGE] }, { rendu: 'logiciel', args: ['--use-gl=disabled', ARG_DEBOGAGE] }];

function chargerPlaywright(chemin) {
  try { return { chemin, pw: createRequire(join(resolve(chemin), 'package.json'))(resolve(chemin)) }; } catch { return null; }
}

/**
 * Les essais d'un rendu, dans l'ordre : le Chromium de chaque paquet, puis le Chrome installé UNE fois (c'est le même pour tous les paquets : chaque
 * essai qui ne rend aucune image coûte 2 s, et cinq paquets le relançaient en vain avant d'atteindre un Chromium, vécu le 18-11 : 16 s de lancement).
 */
export const essaisDeLancement = (modules) => [...modules.map((m) => ({ ...m, opts: {} })), ...modules.slice(0, 1).map((m) => ({ ...m, opts: { channel: 'chrome' } }))];

/** Le navigateur lancé avec `opts` et `args`, gardé seulement s'il affiche des images ; null sinon. */
async function lancerQuiAffiche(pw, opts, args) {
  const navigateur = await pw.chromium.launch({ headless: true, ...opts, args }).catch(() => null);
  if (!navigateur) return null;
  if (await afficheDesImages(navigateur).catch(() => false)) return navigateur;
  await navigateur.close().catch(() => {});
  return null;
}

/**
 * Charge Playwright puis lance Chromium (celui d'un paquet, sinon Chrome installé : essaisDeLancement) ; null quand rien ne se lance. Un navigateur qui ne rend aucune image
 * (GPU de la machine bloqué, vécu le 18-11 sous WSL) est refermé et relancé en rendu logiciel ; `rendu` le dit, le rapport aussi (WebGL y est coupé).
 * Le navigateur prend ses dossiers temporaires (profil, artefacts) dans un dossier à lui, retiré par `fermer()` : une passe ne laisse rien dans le
 * dossier temporaire de la machine. La garde de lecture seule y est armée (armerGarde) ; si elle ne s'arme pas, `gardeErreur` le dit.
 */
export async function lancerNavigateur(env, cwd) {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-sondes-'));
  const avant = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const modules = cheminsPlaywright(env, cwd, processus(), cachesNpx(env.HOME || '')).map(chargerPlaywright).filter(Boolean);
    for (const { rendu, args } of LANCEMENTS) {
      for (const { chemin, pw, opts } of essaisDeLancement(modules)) {
        const navigateur = await lancerQuiAffiche(pw, opts, args);
        if (!navigateur) continue;
        // Sans garde, `sonder` refuse de jouer (lecture seule non garantie) : l'erreur est gardée pour le dire.
        const garde = await armerGarde(navigateur, tmp).catch((e) => ({ erreur: premiereLigne(e) }));
        const fermer = async () => { garde.fermer?.(); await navigateur.close(); rmSync(tmp, { recursive: true, force: true }); };
        return { navigateur, chemin, rendu, gardeErreur: garde.erreur, fermer };
      }
    }
  } finally {
    if (avant === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = avant;
  }
  rmSync(tmp, { recursive: true, force: true });
  return null;
}

const arrondi = (v) => Math.round(Math.abs(v));

const decrireRegion = (quoi, p) => ` ; ${quoi} : ${p.cote}, à ${p.distance} px (${p.region}${p.texte ? ` « ${p.texte} »` : ''})`;
const decrireDefilement = (d) => `${d.cible} ${d.dy ? `dy ${d.dy}` : `dx ${d.dx}`} px`;

/** Le constat de saut, ou rien sous le seuil : il nomme la région changée la plus proche et, si elle diffère, la plus proche au-dessus. */
function constatSaut(m, seuil) {
  const saut = Math.max(Math.abs(m.sautMax ?? 0), Math.abs(m.sautFinal ?? 0));
  if (saut <= seuil) return [];
  const { proche, dessus } = m.regions ?? {};
  let ou = proche ? decrireRegion('région changée la plus proche', proche) : '';
  if (dessus && dessus !== proche) ou += decrireRegion('région changée au-dessus (un ajout au-dessus pousse l\'élément)', dessus);
  return [{ type: 'saut', valeur: arrondi(saut), texte: `saut de ${arrondi(saut)} px de l'élément cliqué (seuil ${seuil} px)${ou}` }];
}

/** Les constats du dialogue ouvert par le clic : focus porté dedans, Échap qui le ferme, focus rendu. */
function constatsDialogue(m) {
  if (!m.dialogue) return [];
  const nom = m.dialogue.nom;
  const out = [];
  if (!m.dialogue.focusDedans) out.push({ type: 'focus', valeur: 0, texte: `dialogue « ${nom} » ouvert sans y porter le focus (WCAG 2.4.3, motif Dialog de l'ARIA APG)` });
  if (m.echap && !m.echap.ferme) out.push({ type: 'echap', valeur: 0, texte: `dialogue « ${nom} » : Échap ne le ferme pas (motif Dialog de l'ARIA APG, WCAG 2.1.2)` });
  else if (m.echap && !m.echap.focusRendu) out.push({ type: 'focus-rendu', valeur: 0, texte: `dialogue « ${nom} » fermé par Échap sans rendre le focus à ce qui l'a ouvert (WCAG 2.4.3)` });
  return out;
}

/** Les constats d'une mesure de clic : chacun nomme la mesure et la règle. Pur, testé sans navigateur. */
export function constatsClic(m, seuil) {
  if (!m) return [];
  const out = constatSaut(m, seuil);
  for (const d of m.defilement ?? []) out.push({ type: 'defilement', valeur: Math.abs(d.dy) + Math.abs(d.dx), texte: `défilement subi sans geste : ${decrireDefilement(d)}` });
  if (m.regions?.horsVue) out.push({ type: 'hors-vue', valeur: m.regions.nombre, texte: `l'effet du clic est hors de la vue : ${m.regions.nombre} région(s) changée(s), aucune visible` });
  return [...out, ...constatsDialogue(m)];
}

const premiereLigne = (e) => String(e?.message ?? e).split('\n')[0];

/**
 * Le clic et sa mesure, sans les écritures. Une navigation (document neuf, ou URL changée) rend { navigation: true, vers } : le contrôle « navigue »,
 * ce n'est ni un constat ni une erreur (revue r1 : un bouton qui fait `location.href = …` plantait la passe avec le code 1).
 */
async function clicMesure(s, id) {
  const { page, o } = s;
  const refus = await page.evaluate((i) => window.__sondes.sdAvant(i), id);
  if (refus) return { nonMesure: refus };
  const navs = s.navigations;
  try {
    await page.click(`[data-sonde-id="${id}"]`, { timeout: 2500 });
  } catch (e) {
    if (s.navigations !== navs) return { navigation: true, vers: page.url() };
    await page.evaluate(() => window.__sondeEtat?.obs.disconnect()).catch(() => {});
    return { nonMesure: `clic impossible : ${premiereLigne(e)}` };
  }
  let m;
  try {
    m = await page.evaluate((ms) => window.__sondes.sdApres(ms), o.attente);
  } catch (e) {
    // Le document a été remplacé pendant la mesure ; l'événement de navigation peut arriver après le rejet.
    if (s.navigations === navs && !/context was destroyed|navigat/i.test(premiereLigne(e))) throw e;
  }
  if (s.navigations !== navs || !m || m.etatPerdu) return { navigation: true, vers: await apresNavigation(s, navs) };
  if (m.dialogue) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    m.echap = await page.evaluate(() => window.__sondes.sdApresEchap());
  }
  return m;
}

/** L'URL où la page est allée : on attend (2 s au plus) que la navigation soit vue puis chargée. */
async function apresNavigation(s, navs) {
  for (let t = 0; s.navigations === navs && t < 2000; t += 50) await s.page.waitForTimeout(50);
  await s.page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  return s.page.url();
}

/**
 * Un clic mesuré : avant, clic réel, suivi image par image, puis Échap si un dialogue s'est ouvert ; les écritures tentées pendant ce temps lui sont
 * rattachées. Une navigation partie juste après la mesure (bouton qui navigue en différé) fait encore de ce clic un clic qui navigue.
 */
async function mesurerClic(s, id, ou) {
  const debut = s.ecritures.length;
  const navs = s.navigations;
  let m = await clicMesure(s, id);
  await s.page.waitForTimeout(150); // une écriture ou une navigation partie à la fin de la mesure est rattachée ici, pas au clic suivant
  if (!m.navigation && s.navigations !== navs) m = { navigation: true, vers: await apresNavigation(s, navs) };
  const ecritures = s.ecritures.slice(debut);
  for (const e of ecritures) e.ou = ou;
  if (ecritures.length) m.ecritures = ecritures;
  return m;
}

/**
 * Ouvre la page dans un onglet neuf (l'ancien est fermé) : une navigation lancée par la page juste avant (bouton qui navigue en différé) ne peut
 * pas interrompre la réouverture. Les navigations du document principal sont comptées dans `s.navigations`.
 */
async function ouvrir(s) {
  const ancien = s.page;
  const page = await s.contexte.newPage();
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) s.navigations += 1; });
  s.page = page;
  if (ancien) await ancien.close().catch(() => {});
  await s.page.goto(s.url, { waitUntil: 'load', timeout: 60000 });
  await s.page.waitForTimeout(s.o.charge);
}

async function capturer(page, o, nom) {
  if (!o.captures) return undefined;
  mkdirSync(o.captures, { recursive: true });
  const chemin = join(o.captures, `${nom}.png`);
  await page.screenshot({ path: chemin });
  return chemin;
}

const ouControle = (c) => `« ${c.nom} » (${c.role}${c.liste ? ' de liste' : ''})`;

/**
 * Le balayage : chaque contrôle marqué est cliqué, mesuré, puis remis dans son état (second clic mesuré lui aussi) ; une navigation est défaite
 * (page rouverte, contrôles marqués à nouveau). Une erreur de la sonde sur un contrôle le rend non mesuré et rouvre la page : la passe continue.
 */
async function balayer(s) {
  const { o } = s;
  const marquer = () => s.page.evaluate(([max, pl]) => window.__sondes.sdMarquer(max, pl), [o.max, o.parListe]);
  const { controles, couverts } = await marquer();
  for (const c of controles) {
    let rouvrir = false;
    try {
      const m = await mesurerClic(s, c.id, ouControle(c));
      c.mesure = m;
      c.constats = constatsClic(m, o.seuil);
      if (c.constats.length) c.capture = await capturer(s.page, o, `controle-${c.id}`);
      if (m.navigation) rouvrir = true;
      else if (m.etatChange && !m.dialogue) {
        c.retour = await mesurerClic(s, c.id, ouControle(c));
        c.constats.push(...constatsClic(c.retour, o.seuil).map((k) => ({ ...k, texte: `au second clic (retour à l'état d'origine) : ${k.texte}` })));
        if (c.retour.navigation) rouvrir = true;
      }
    } catch (e) {
      c.mesure = { nonMesure: `erreur de la sonde : ${premiereLigne(e)}` };
      c.constats ??= [];
      rouvrir = true;
    }
    if (rouvrir) {
      await ouvrir(s);
      await marquer();
    }
    await s.page.waitForTimeout(150);
  }
  return { controles, couverts };
}

async function etape(s, e, k) {
  const { page, o } = s;
  if (e.type === 'attendre') { await page.waitForTimeout(e.ms); return []; }
  if (e.type === 'touche') {
    await page.keyboard.press(e.touche);
    await page.waitForTimeout(500);
    const echap = await page.evaluate(() => window.__sondes?.sdApresEchap() ?? null);
    return [{ etape: `touche ${e.touche}`, mesure: { echap }, constats: echap && !echap.ferme ? [{ type: 'echap', valeur: 0, texte: `${e.touche} ne ferme pas le dialogue ouvert (motif Dialog de l'ARIA APG)` }] : [] }];
  }
  const cibles = await page.evaluate(([sel, n, p]) => window.__sondes.sdMarquerSelecteur(sel, n, p), [e.sel, e.n, `p${k}`]);
  const out = [];
  if (cibles.length < e.n) out.push({ etape: `cliquer ${e.sel} ×${e.n}`, nonMesure: `${cibles.length} élément(s) visible(s) pour ${e.n} attendu(s)`, constats: [] });
  for (const c of cibles) {
    let m;
    try {
      m = await mesurerClic(s, c.id, `parcours, cliquer ${e.sel} « ${c.nom} »`);
    } catch (err) {
      m = { nonMesure: `erreur de la sonde : ${premiereLigne(err)}` };
    }
    const constats = constatsClic(m, o.seuil);
    out.push({ etape: `cliquer ${e.sel}`, nom: c.nom, mesure: m, constats, capture: constats.length ? await capturer(page, o, `parcours-${c.id}`) : undefined });
  }
  return out;
}

async function jouerParcours(s, parcours) {
  const out = [];
  for (const [k, p] of parcours.entries()) {
    await ouvrir(s);
    const pas = [];
    for (const [j, e] of p.etapes.entries()) pas.push(...await etape(s, e, `${k + 1}-${j + 1}`));
    out.push({ nom: p.nom, pas });
  }
  return out;
}

/**
 * Toute la passe sur une page, en lecture seule : la garde du navigateur (scripts/sondes-garde.mjs) doit être armée, sinon rien n'est sondé (lève).
 * Chaque écriture tentée est coupée, comptée et rattachée au clic qui l'a faite ; les Workers dédiés gardés, les cibles non gardées et les fonctions
 * retirées que la page a demandées (`coupees`, revue r3) sont rendus.
 */
export async function sonder(navigateur, url, o, parcours) {
  const garde = gardeDe(navigateur);
  if (!garde) throw new Error('garde de lecture seule absente (navigateur lancé sans port de débogage) : lecture seule non garantie, rien n\'est sondé');
  const ecritures = [];
  const coupees = [];
  const restes = [];
  const erreursCoupees = [];
  garde.ouvrirPasse(ecritures);
  const contexte = await navigateur.newContext({ viewport: { width: o.largeur, height: o.hauteur }, serviceWorkers: 'block' });
  let bilanGarde;
  try {
    await couperLesEcritures(contexte, ecritures, coupees, restes, erreursCoupees);
    await contexte.addInitScript({ content: SCRIPT_SONDES });
    const s = { contexte, page: null, url, o, ecritures, navigations: 0 };
    await ouvrir(s);
    const repos = await s.page.evaluate((ms) => window.__sondes.sdRepos(ms), o.repos);
    const { controles, couverts } = o.sansBalayage ? { controles: [], couverts: [] } : await balayer(s);
    const parcoursMesures = await jouerParcours(s, parcours);
    await s.page.waitForTimeout(150); // une note de la garde partie à la fin est encore comptée
    for (const e of ecritures) e.ou ??= 'hors de tout clic (chargement, minuterie)';
    bilanGarde = garde.fermerPasse();
    return { url, largeur: o.largeur, hauteur: o.hauteur, seuil: o.seuil, date: new Date().toISOString(), rendu: o.rendu, repos, controles, couverts, parcours: parcoursMesures,
      ecrituresBloquees: ecritures.length, ecritures, workers: bilanGarde.workers, nonGardes: [...bilanGarde.echecs, ...restes], coupees, erreursCoupees };
  } finally {
    if (!bilanGarde) garde.fermerPasse();
    await contexte.close();
  }
}

const nomDuPas = (p, s) => `parcours « ${p.nom} », ${s.etape}${s.nom ? ` « ${s.nom} »` : ''}`;

/** Tous les constats d'un rapport, à plat : où, quoi. */
export function tousLesConstats(r) {
  const out = r.repos.map((d) => ({ ou: 'au repos', type: 'defilement', texte: `défilement subi sans geste, au repos : ${decrireDefilement(d)}` }));
  for (const c of r.controles) for (const k of c.constats ?? []) out.push({ ou: `« ${c.nom} » (${c.role}${c.liste ? ' de liste' : ''})`, ...k });
  for (const p of r.parcours) for (const s of p.pas) for (const k of s.constats) out.push({ ou: nomDuPas(p, s), ...k });
  return out;
}

const echapFerme = (e) => (e?.ferme ? 'ferme' : 'ne ferme pas');

/** La ligne d'un clic sans saut mesuré : non mesuré, navigation, touche ; null quand le saut a été mesuré. */
function ligneSansSaut(m) {
  if (m.nonMesure) return `non mesuré (${m.nonMesure})`;
  if (m.sautMax !== undefined) return null;
  if (m.navigation) return `navigue vers ${m.vers} (page rouverte)`;
  return m.echap ? `Échap ${echapFerme(m.echap)} le dialogue` : 'fait';
}

/** La ligne de mesure d'un clic, constat ou non. */
function ligneMesure(m = {}) {
  const sans = ligneSansSaut(m);
  if (sans) return sans;
  const p = m.regions?.proche;
  const dialogue = m.dialogue ? `, dialogue (focus ${m.dialogue.focusDedans ? 'dedans' : 'dehors'}, Échap ${echapFerme(m.echap)})` : '';
  const remplace = m.remplace ? ', élément remplacé par le clic, suivi par son équivalent' : '';
  return `saut ${m.sautMax ?? '—'} px, défilement ${m.defilement?.length ?? 0}, région la plus proche ${p ? `${p.cote} à ${p.distance} px` : 'aucune'}${remplace}${dialogue}`;
}

const decrireEcriture = (e) => `${e.voie}${e.cible && !e.detail.includes(e.cible) ? ` ${e.cible}` : ''}${e.detail ? ` « ${e.detail} »` : ''}`;
const ecritesPar = (m) => (m?.ecritures?.length ? `le clic a tenté d'écrire, bloqué (${m.ecritures.map(decrireEcriture).join(' ; ')}) : son effet réel n'est pas vérifié` : '');

/**
 * Les clics qui n'ont pas pu être mesurés, ou pas pour de vrai : élément disparu ou remplacé sans équivalent, clic refusé, contrôle couvert, éléments
 * de parcours manquants, clic qui a tenté d'écrire (bloqué, donc l'app n'a pas reçu sa réponse) : « où — pourquoi ».
 */
export function nonMesures(r) {
  const raisons = (ou, liste) => liste.filter(Boolean).map((pourquoi) => `${ou} — ${pourquoi}`);
  const out = r.controles.flatMap((c) => raisons(`« ${c.nom} »`, [c.mesure?.nonMesure, ecritesPar(c.mesure), ecritesPar(c.retour)]));
  for (const c of r.couverts ?? []) out.push(`« ${c.nom} » — couvert par un autre élément à cette taille de vue : non mesurable`);
  for (const p of r.parcours) for (const s of p.pas) out.push(...raisons(nomDuPas(p, s), [s.nonMesure ?? s.mesure?.nonMesure, ecritesPar(s.mesure)]));
  return out;
}

const mesure = (m) => !!m && !m.nonMesure && m.sautMax !== undefined && m.sautMax !== null;

/** Les clics dont le saut a vraiment été mesuré (balayage et parcours) ; un contrôle qui navigue n'en est pas un. */
export function clicsMesures(r) {
  return r.controles.filter((c) => mesure(c.mesure)).length + r.parcours.reduce((n, p) => n + p.pas.filter((s) => !s.nonMesure && mesure(s.mesure)).length, 0);
}

/**
 * Le code de sortie : 2 quand une cible n'a pas pu être gardée (worker, SharedWorker ou service worker démarré, fonction non retirée : lecture seule non garantie : non vérifié), 1 avec constats, 4 non mesurable (aucun clic mesuré : rien n'est vérifié), 3 passe partielle (des clics non mesurés,
 * couverts ou qui ont tenté d'écrire, ou une erreur de la page sur une fonction coupée : revue r3), 0 tout mesuré sans constat. Les autres codes 2 (usage, navigateur, erreur de la passe) sont rendus par main.
 */
export function codeSortie(r) {
  if (r.nonGardes?.length) return 2;
  if (tousLesConstats(r).length) return 1;
  if (!clicsMesures(r)) return 4;
  return nonMesures(r).length || r.erreursCoupees?.length ? 3 : 0;
}

/** La ligne de bilan : les constats, sinon « aucun constat » (passe partielle dite), sinon « non mesurable » quand aucun clic n'a été mesuré. */
function bilan(constats, manques, mesures, erreurs = 0) {
  if (constats) return `${constats} constat(s) :`;
  if (!mesures) return 'aucun clic mesuré : non mesurable, rien n\'est vérifié';
  if (manques) return 'aucun constat sur ce qui a été mesuré (passe partielle, voir les non-mesurés)';
  return `aucun constat${erreurs ? ' sur ce qui a été mesuré (passe partielle : la page a levé une erreur sur une fonction coupée, voir « lecture seule »)' : ''}`;
}

/** Les deux lignes d'en-tête : page, taille, seuil, date (et rendu logiciel), puis les comptes. */
function entete(r, manques, mesures) {
  const rendu = r.rendu === 'logiciel' ? ' — rendu logiciel (le GPU de la machine ne rendait aucune image) : WebGL coupé, ce qu\'il dessine n\'est pas sondé' : '';
  return [`sondes d'interaction — ${r.url} — ${r.largeur}×${r.hauteur} — seuil de saut ${r.seuil} px — ${r.date}${rendu}`,
    `${r.controles.length} contrôle(s) balayé(s), ${(r.couverts ?? []).length} couvert(s), ${r.parcours.length} parcours, ${mesures} clic(s) mesuré(s), `
      + `${manques} clic(s) non mesuré(s), ${r.ecrituresBloquees} écriture(s) tentée(s), bloquée(s)`];
}

/** Le compte rendu lisible : en-tête, constats, non-mesurés, écritures bloquées, puis une ligne par contrôle et par pas de parcours. */
export function formater(r) {
  const constats = tousLesConstats(r);
  const manques = nonMesures(r);
  const ecritures = r.ecritures ?? [];
  const mesures = clicsMesures(r);
  const lignes = [...entete(r, manques.length, mesures), bilan(constats.length, manques.length, mesures, r.erreursCoupees?.length ?? 0)];
  for (const k of constats) lignes.push(`  ✗ ${k.ou} : ${k.texte}`);
  if (manques.length) lignes.push(`non mesuré(s) : ${manques.length}`, ...manques.map((m) => `  ? ${m}`));
  lignes.push(...lectureSeule(r));
  if (ecritures.length) lignes.push(`écriture(s) tentée(s), coupée(s) dans le navigateur avant d'en sortir : ${ecritures.length}`, ...ecritures.map((e) => `  ! ${e.ou} : ${decrireEcriture(e)}`));
  lignes.push('mesures :');
  for (const c of r.controles) lignes.push(`  ${c.id}. « ${c.nom} » (${c.role}) : ${ligneMesure(c.mesure)}`);
  for (const p of r.parcours) for (const s of p.pas) lignes.push(`  ${nomDuPas(p, s)} : ${s.nonMesure ? `non mesuré (${s.nonMesure})` : ligneMesure(s.mesure)}`);
  return lignes.join('\n');
}

const NOMBRES = { largeur: 'largeur', hauteur: 'hauteur', seuil: 'seuil', max: 'max', 'par-liste': 'parListe', attente: 'attente', charge: 'charge', repos: 'repos' };

/** La ligne de commande en options ; lève une Error lisible. */
export function lireOptions(argv) {
  const opts = Object.fromEntries(Object.keys(NOMBRES).map((k) => [k, { type: 'string' }]));
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...opts, attendus: { type: 'string' }, route: { type: 'string' },
    json: { type: 'string' }, captures: { type: 'string' }, 'sans-balayage': { type: 'boolean' } } });
  if (positionals.length !== 1 || !/^(https?|file):/.test(positionals[0])) throw new Error(USAGE);
  const o = { ...DEFAUTS, url: positionals[0], attendus: values.attendus, route: values.route, json: values.json, captures: values.captures, sansBalayage: !!values['sans-balayage'] };
  for (const [cle, champ] of Object.entries(NOMBRES)) {
    if (values[cle] === undefined) continue;
    const n = Number(values[cle]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${cle} : nombre positif attendu, reçu « ${values[cle]} »`);
    o[champ] = n;
  }
  return o;
}

/**
 * `cadence sondes` : 0 tout mesuré sans constat, 1 avec constats (et seulement alors), 3 sans constat mais des clics non mesurés (passe partielle),
 * 4 aucun clic mesuré (non mesurable), 2 usage, attendus illisibles, navigateur introuvable, garde de lecture seule non armée, cible (worker) non
 * gardée ou passe interrompue par une erreur (non vérifié).
 */
export async function main(argv, io) {
  let o;
  let parcours = [];
  try {
    o = lireOptions(argv);
    const fichier = o.attendus ?? (existsSync(join(io.cwd, 'docs/qa/expectations.md')) ? join(io.cwd, 'docs/qa/expectations.md') : undefined);
    if (fichier) parcours = lireParcours(readFileSync(resolve(io.cwd, fichier), 'utf8'), o.route ?? new URL(o.url).pathname);
  } catch (e) {
    io.err(`sondes : ${e.message}`);
    return 2;
  }
  const lance = await lancerNavigateur(io.env, io.cwd);
  if (!lance) {
    io.err('sondes : aucun Playwright chargeable ni navigateur lançable (CADENCE_PLAYWRIGHT, node_modules, serveur MCP Playwright, cache npx) ; rien n\'est installé : non vérifié');
    return 2;
  }
  try {
    if (lance.gardeErreur) {
      io.err(`sondes : garde de lecture seule non armée (${lance.gardeErreur}) : rien n'est sondé, non vérifié`);
      return 2;
    }
    const r = await sonder(lance.navigateur, o.url, { ...o, rendu: lance.rendu }, parcours);
    if (o.json) writeFileSync(resolve(io.cwd, o.json), JSON.stringify(r, null, 2) + '\n');
    io.out(formater(r));
    return codeSortie(r);
  } catch (e) {
    io.err(`sondes : la passe s'est interrompue (${premiereLigne(e)}) : non vérifié`);
    return 2;
  } finally {
    await lance.fermer();
  }
}
