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

/** Où chercher Playwright, dans l'ordre : CADENCE_PLAYWRIGHT, le node_modules du dépôt, le serveur MCP Playwright en cours, le cache npx le plus récent. */
export function cheminsPlaywright(env, cwd, processus, caches) {
  const out = [];
  if (env.CADENCE_PLAYWRIGHT) out.push(env.CADENCE_PLAYWRIGHT);
  out.push(join(cwd, 'node_modules', 'playwright'));
  for (const ligne of processus) {
    const m = /(\S+)\/node_modules\/\.bin\/playwright-mcp/.exec(ligne);
    if (m) out.push(join(m[1], 'node_modules', 'playwright'));
  }
  return [...out, ...caches];
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

/**
 * Charge Playwright puis lance Chromium (celui du paquet, sinon Chrome installé) ; null quand rien ne se lance. Le navigateur prend ses dossiers
 * temporaires (profil, artefacts) dans un dossier à lui, retiré par `fermer()` : une passe ne laisse rien dans le dossier temporaire de la machine.
 */
export async function lancerNavigateur(env, cwd) {
  const tmp = mkdtempSync(join(tmpdir(), 'cadence-sondes-'));
  const avant = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    for (const chemin of cheminsPlaywright(env, cwd, processus(), cachesNpx(env.HOME || ''))) {
      let pw;
      try { pw = createRequire(join(resolve(chemin), 'package.json'))(resolve(chemin)); } catch { continue; }
      for (const opts of [{}, { channel: 'chrome' }]) {
        try {
          const navigateur = await pw.chromium.launch({ headless: true, ...opts });
          return { navigateur, chemin, fermer: async () => { await navigateur.close(); rmSync(tmp, { recursive: true, force: true }); } };
        } catch { /* candidat suivant */ }
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

/** Un clic mesuré : avant, clic réel, suivi image par image, puis Échap si un dialogue s'est ouvert. */
async function mesurerClic(page, id, o) {
  const refus = await page.evaluate((i) => window.__sondes.sdAvant(i), id);
  if (refus) return { nonMesure: refus };
  try {
    await page.click(`[data-sonde-id="${id}"]`, { timeout: 2500 });
  } catch (e) {
    await page.evaluate(() => window.__sondeEtat?.obs.disconnect());
    return { nonMesure: `clic impossible : ${String(e.message).split('\n')[0]}` };
  }
  const m = await page.evaluate((ms) => window.__sondes.sdApres(ms), o.attente);
  if (m.dialogue) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    m.echap = await page.evaluate(() => window.__sondes.sdApresEchap());
  }
  return m;
}

async function ouvrir(page, url, o) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(o.charge);
}

async function capturer(page, o, nom) {
  if (!o.captures) return undefined;
  mkdirSync(o.captures, { recursive: true });
  const chemin = join(o.captures, `${nom}.png`);
  await page.screenshot({ path: chemin });
  return chemin;
}

/** Le balayage : chaque contrôle marqué est cliqué, mesuré, puis remis dans son état (second clic mesuré lui aussi) ; une navigation est défaite. */
async function balayer(page, url, o) {
  const marquer = () => page.evaluate(([max, pl]) => window.__sondes.sdMarquer(max, pl), [o.max, o.parListe]);
  const controles = await marquer();
  for (const c of controles) {
    const m = await mesurerClic(page, c.id, o);
    c.mesure = m;
    c.constats = constatsClic(m, o.seuil);
    if (c.constats.length) c.capture = await capturer(page, o, `controle-${c.id}`);
    if (m.navigation) {
      await ouvrir(page, url, o);
      await marquer();
    } else if (m.etatChange && !m.dialogue) {
      c.retour = await mesurerClic(page, c.id, o);
      c.constats.push(...constatsClic(c.retour, o.seuil).map((k) => ({ ...k, texte: `au second clic (retour à l'état d'origine) : ${k.texte}` })));
    }
    await page.waitForTimeout(150);
  }
  return controles;
}

async function etape(page, e, k, o) {
  if (e.type === 'attendre') { await page.waitForTimeout(e.ms); return []; }
  if (e.type === 'touche') {
    await page.keyboard.press(e.touche);
    await page.waitForTimeout(500);
    const echap = await page.evaluate(() => window.__sondes.sdApresEchap());
    return [{ etape: `touche ${e.touche}`, mesure: { echap }, constats: echap && !echap.ferme ? [{ type: 'echap', valeur: 0, texte: `${e.touche} ne ferme pas le dialogue ouvert (motif Dialog de l'ARIA APG)` }] : [] }];
  }
  const cibles = await page.evaluate(([sel, n, p]) => window.__sondes.sdMarquerSelecteur(sel, n, p), [e.sel, e.n, `p${k}`]);
  const out = [];
  if (cibles.length < e.n) out.push({ etape: `cliquer ${e.sel} ×${e.n}`, nonMesure: `${cibles.length} élément(s) visible(s) pour ${e.n} attendu(s)`, constats: [] });
  for (const c of cibles) {
    const m = await mesurerClic(page, c.id, o);
    const constats = constatsClic(m, o.seuil);
    out.push({ etape: `cliquer ${e.sel}`, nom: c.nom, mesure: m, constats, capture: constats.length ? await capturer(page, o, `parcours-${c.id}`) : undefined });
  }
  return out;
}

async function jouerParcours(page, url, parcours, o) {
  const out = [];
  for (const [k, p] of parcours.entries()) {
    await ouvrir(page, url, o);
    const pas = [];
    for (const [j, e] of p.etapes.entries()) pas.push(...await etape(page, e, `${k + 1}-${j + 1}`, o));
    out.push({ nom: p.nom, pas });
  }
  return out;
}

/** Toute la passe sur une page ; les requêtes qui écrivent (POST, PUT, PATCH, DELETE) sont bloquées et comptées. */
export async function sonder(navigateur, url, o, parcours) {
  const contexte = await navigateur.newContext({ viewport: { width: o.largeur, height: o.hauteur } });
  let bloquees = 0;
  await contexte.route('**/*', (r) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.request().method())) return r.continue();
    bloquees += 1;
    return r.abort();
  });
  await contexte.addInitScript({ content: SCRIPT_SONDES });
  const page = await contexte.newPage();
  try {
    await ouvrir(page, url, o);
    const repos = await page.evaluate((ms) => window.__sondes.sdRepos(ms), o.repos);
    const controles = o.sansBalayage ? [] : await balayer(page, url, o);
    const parcoursMesures = await jouerParcours(page, url, parcours, o);
    return { url, largeur: o.largeur, hauteur: o.hauteur, seuil: o.seuil, date: new Date().toISOString(), repos, controles, parcours: parcoursMesures, ecrituresBloquees: bloquees };
  } finally {
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

/** La ligne de mesure d'un clic, constat ou non. */
function ligneMesure(m = {}) {
  if (m.nonMesure) return `non mesuré (${m.nonMesure})`;
  if (m.sautMax === undefined) return m.echap ? `Échap ${m.echap.ferme ? 'ferme' : 'ne ferme pas'} le dialogue` : 'fait';
  const p = m.regions?.proche;
  const dialogue = m.dialogue ? `, dialogue (focus ${m.dialogue.focusDedans ? 'dedans' : 'dehors'}, Échap ${m.echap?.ferme ? 'ferme' : 'ne ferme pas'})` : '';
  return `saut ${m.sautMax ?? '—'} px, défilement ${m.defilement?.length ?? 0}, région la plus proche ${p ? `${p.cote} à ${p.distance} px` : 'aucune'}${dialogue}`;
}

/** Les clics qui n'ont pas pu être mesurés (élément disparu, clic refusé, éléments de parcours manquants) : « où — pourquoi ». */
export function nonMesures(r) {
  const out = r.controles.filter((c) => c.mesure?.nonMesure).map((c) => `« ${c.nom} » — ${c.mesure.nonMesure}`);
  for (const p of r.parcours) for (const s of p.pas) {
    const pourquoi = s.nonMesure ?? s.mesure?.nonMesure;
    if (pourquoi) out.push(`${nomDuPas(p, s)} — ${pourquoi}`);
  }
  return out;
}

/** Le compte rendu lisible : en-tête, constats, non-mesurés, puis une ligne par contrôle et par pas de parcours. */
export function formater(r) {
  const constats = tousLesConstats(r);
  const manques = nonMesures(r);
  const lignes = [`sondes d'interaction — ${r.url} — ${r.largeur}×${r.hauteur} — seuil de saut ${r.seuil} px — ${r.date}`,
    `${r.controles.length} contrôle(s) balayé(s), ${r.parcours.length} parcours, ${manques.length} clic(s) non mesuré(s), ${r.ecrituresBloquees} requête(s) d'écriture bloquée(s)`,
    constats.length ? `${constats.length} constat(s) :` : `aucun constat${manques.length ? ' sur ce qui a été mesuré (passe partielle, voir les non-mesurés)' : ''}`];
  for (const k of constats) lignes.push(`  ✗ ${k.ou} : ${k.texte}`);
  if (manques.length) lignes.push(`non mesuré(s) : ${manques.length}`, ...manques.map((m) => `  ? ${m}`));
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

/** `cadence sondes` : 0 tout mesuré sans constat, 1 avec constats, 3 sans constat mais des clics non mesurés (passe partielle), 2 usage, attendus illisibles ou navigateur introuvable. */
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
    const r = await sonder(lance.navigateur, o.url, o, parcours);
    if (o.json) writeFileSync(resolve(io.cwd, o.json), JSON.stringify(r, null, 2) + '\n');
    io.out(formater(r));
    if (tousLesConstats(r).length) return 1;
    return nonMesures(r).length ? 3 : 0;
  } finally {
    await lance.fermer();
  }
}
