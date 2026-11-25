// Mesures de mise en page (L839, demande D-34) : le « mode script » du ux-reviewer. Au lieu de clics et d'instantanés Playwright un par un, dont
// chaque page remonte dans le contexte de l'agent, une passe mesure d'un coup, à chaque largeur et dans chaque état demandé : l'enveloppe
// (vue, document, repères et gouttières), le défilement horizontal et ce qui le cause, les textes tronqués, les mots coupés sur deux lignes,
// les valeurs séparées de leur unité, les libellés courts qui passent à la ligne, les cibles sous 24 px et la plus petite police ; elle ne
// rend que les chiffres. Générique : rien de propre à un projet. Lancé par `cadence mesures <url>` (bin/cadence.js).
// Playwright est pris sur la machine comme pour les sondes (scripts/sondes-interaction.mjs), jamais installé. Doc : docs/mesures-page.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { lancerNavigateur, lireParcours } from './sondes-interaction.mjs';
import { scriptMesures } from './mesures-page-dom.mjs';

/** Les largeurs de la grille de livraison de l'agent (375, 768, 1024, 1440 px) ; la hauteur d'un écran de portable. */
export const DEFAUTS = Object.freeze({ largeurs: [375, 768, 1024, 1440], hauteur: 900, charge: 2000, max: 5, plafondMots: 20000 });

const USAGE = 'usage : cadence mesures <url> [--largeurs 375,768,1024,1440] [--hauteur 900] [--charge 2000] [--max 5] '
  + '[--etat "<nom> → cliquer <sélecteur> ; attendre <ms> ; touche <touche>"]… [--json fichier] [--captures dossier]';

/** Les familles de constats, dans l'ordre du compte rendu : clé, nom, ligne qui en décrit un, nom court de la ligne de chiffres. */
const FAMILLES = [
  ['debordements', 'déborde du bord droit', (d) => `${d.sel} de ${d.px} px (largeur ${d.largeur} px)${cite(d.texte)}`, 'débord.'],
  ['tronques', 'texte tronqué', (d) => `${d.sel} : ${d.visible} px visibles sur ${d.contenu}${cite(d.texte)}`, 'tronqués'],
  ['coupures', 'mot coupé sur deux lignes', (d) => `${d.sel} : « ${d.coupe} »${d.trait ? ' (après un trait)' : ''}`, 'mots coupés'],
  ['separees', 'valeur séparée de son unité', (d) => `${d.sel} : « ${d.valeur} » | « ${d.unite} »`, 'unités séparées'],
  ['sautsDeLigne', 'libellé court sur plusieurs lignes', (d) => `${d.sel} : ${d.lignes} lignes dans ${d.largeur} px${cite(d.texte)}`, 'libellés sur 2+ lignes'],
  ['cibles', 'cible sous 24 × 24 px', (d) => `${d.sel} : ${d.largeur} × ${d.hauteur} px${cite(d.texte)}`, 'cibles < 24'],
];

const cite = (t) => (t ? ` « ${t} »` : '');
const premiereLigne = (e) => String(e?.message ?? e).split('\n')[0];

/** Un état demandé : « <nom> → <étapes> », dans la syntaxe des lignes `parcours:` des sondes (cliquer, attendre, touche). */
export function lireEtat(texte) {
  const [p] = lireParcours(`## e\nparcours: ${texte}`, 'e');
  if (!p) throw new Error(`--etat « ${texte} » : attendu « <nom> → cliquer <sélecteur> ; attendre <ms> ; touche <touche> »`);
  return p;
}

/** La ligne de commande en options ; lève une Error lisible. */
export function lireOptions(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { largeurs: { type: 'string' }, hauteur: { type: 'string' },
    charge: { type: 'string' }, max: { type: 'string' }, etat: { type: 'string', multiple: true }, json: { type: 'string' }, captures: { type: 'string' } } });
  if (positionals.length !== 1 || !/^(https?|file):/.test(positionals[0])) throw new Error(USAGE);
  const o = { ...DEFAUTS, url: positionals[0], json: values.json, captures: values.captures, etats: (values.etat ?? []).map(lireEtat) };
  if (values.largeurs !== undefined) {
    o.largeurs = values.largeurs.split(',').map((l) => Number(l.trim()));
    if (!o.largeurs.length || o.largeurs.some((l) => !Number.isInteger(l) || l < 200)) throw new Error(`--largeurs : entiers ≥ 200 séparés par des virgules, reçu « ${values.largeurs} »`);
  }
  for (const cle of ['hauteur', 'charge', 'max']) {
    if (values[cle] === undefined) continue;
    const n = Number(values[cle]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${cle} : nombre positif attendu, reçu « ${values[cle]} »`);
    o[cle] = n;
  }
  return o;
}

/** Joue les étapes d'un état (clic sur le premier élément visible du sélecteur, ou les N premiers). */
async function jouerEtapes(page, etapes) {
  for (const e of etapes) {
    if (e.type === 'attendre') await page.waitForTimeout(e.ms);
    else if (e.type === 'touche') await page.keyboard.press(e.touche);
    else for (let i = 0; i < e.n; i++) await page.locator(e.sel).locator('visible=true').nth(i).click({ timeout: 3000 });
    await page.waitForTimeout(200);
  }
}

/** Une largeur : la page ouverte une fois par état (état de base puis chaque `--etat`), mesurée d'un appel, capturée si demandé. */
async function mesurerLargeur(contexte, o, largeur) {
  const out = [];
  for (const etat of [{ nom: 'base', etapes: [] }, ...o.etats]) {
    const page = await contexte.newPage();
    try {
      await page.goto(o.url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(o.charge);
      await jouerEtapes(page, etat.etapes);
      const m = await page.evaluate(scriptMesures(o.plafondMots));
      out.push({ etat: etat.nom, largeur, ...m, capture: await capturer(page, o, `mesures-${etat.nom}-${largeur}`) });
    } catch (e) {
      out.push({ etat: etat.nom, largeur, erreur: premiereLigne(e) });
    } finally {
      await page.close();
    }
  }
  return out;
}

async function capturer(page, o, nom) {
  if (!o.captures) return undefined;
  mkdirSync(o.captures, { recursive: true });
  const chemin = join(o.captures, `${nom.replace(/[^\p{L}\d-]+/gu, '-')}.png`);
  await page.screenshot({ path: chemin, fullPage: true });
  return chemin;
}

/**
 * Toute la passe : une largeur après l'autre, dans un contexte neuf. Les requêtes autres que GET sont coupées (204 vide) : un état demandé
 * clique pour de vrai, et une page qui écrit au chargement n'écrit pas. Ce n'est pas la garde des sondes (WebSocket et workers ne sont pas coupés).
 */
export async function mesurer(navigateur, o) {
  const passes = [];
  let ecrituresCoupees = 0;
  for (const largeur of o.largeurs) {
    const contexte = await navigateur.newContext({ viewport: { width: largeur, height: o.hauteur }, serviceWorkers: 'block' });
    await contexte.route('**/*', (r) => {
      if (r.request().method() === 'GET' || r.request().method() === 'HEAD') return r.continue();
      ecrituresCoupees += 1;
      return r.fulfill({ status: 204, body: '' });
    });
    try {
      passes.push(...await mesurerLargeur(contexte, o, largeur));
    } finally {
      await contexte.close();
    }
  }
  return { url: o.url, hauteur: o.hauteur, date: new Date().toISOString(), rendu: o.rendu, passes, ecrituresCoupees };
}

/** Le nombre de constats d'une passe (une passe en erreur n'en a pas : elle est « non vérifiée »). */
export const constatsDe = (p) => (p.erreur ? 0 : FAMILLES.reduce((n, [cle]) => n + p[cle].length, 0) + (p.defilementHorizontal > 0 ? 1 : 0));

/** 2 quand une passe n'a pas pu être mesurée (non vérifié), 1 avec constats, 0 sans. */
export function codeSortie(r) {
  if (!r.passes.length || r.passes.some((p) => p.erreur)) return 2;
  return r.passes.some((p) => constatsDe(p) > 0) ? 1 : 0;
}

const repere = (x) => `${x.sel} ${x.gauche}+${x.largeur}+${x.droite}`;

/** La ligne de chiffres d'une passe : ce qu'une capture aurait montré, en une ligne. */
export function ligneChiffres(p) {
  if (p.erreur) return `${p.largeur} ${p.etat} : non mesuré (${p.erreur})`;
  const comptes = FAMILLES.map(([cle, , , court]) => `${court} ${p[cle].length}`).join(', ');
  const police = p.polices.min === null ? 'aucun texte' : `police min ${Math.round(p.polices.min * 10) / 10} px (${p.polices.sous12} sous 12)`;
  const plafond = p.plafondAtteint ? ' (plafond atteint : la suite n\'est pas lue)' : '';
  return `${p.largeur} ${p.etat} : document ${p.document}/${p.vue}, défil. horizontal ${p.defilementHorizontal} ; ${comptes} ; ${police} ; `
    + `${p.motsLus} mots${plafond} ; repères (g+l+d) ${p.reperes.map(repere).join(', ') || 'aucun'}`;
}

/** Où un constat est vu : « 375, 768 px (base, panneau) ». */
const ou = (vus) => `${[...new Set(vus.map((v) => v.largeur))].join(', ')} px (${[...new Set(vus.map((v) => v.etat))].join(', ')})`;

/**
 * Les constats regroupés : un même élément au même texte, vu à plusieurs largeurs ou dans plusieurs états, fait UNE ligne qui dit où ; le
 * détail est celui de la plus petite largeur. `max` groupes par famille au plus (la suite est comptée, le JSON a tout).
 */
export function constatsGroupes(r) {
  const passes = r.passes.filter((p) => !p.erreur);
  const out = [];
  const defil = passes.filter((p) => p.defilementHorizontal > 0);
  if (defil.length) out.push({ famille: 'defilement', nom: 'défilement horizontal', detail: `jusqu'à ${Math.max(...defil.map((p) => p.defilementHorizontal))} px`, vus: defil });
  for (const [cle, nom, dire] of FAMILLES) {
    const groupes = new Map();
    for (const p of passes) for (const d of p[cle]) {
      const k = JSON.stringify([d.sel, d.texte ?? d.mot ?? d.valeur ?? '']);
      if (!groupes.has(k)) groupes.set(k, { famille: cle, nom, detail: dire(d), vus: [] });
      groupes.get(k).vus.push(p);
    }
    out.push(...groupes.values());
  }
  return out;
}

function lignesConstats(groupes, max) {
  const out = [];
  const parFamille = new Map();
  for (const g of groupes) parFamille.set(g.famille, [...(parFamille.get(g.famille) ?? []), g]);
  for (const liste of parFamille.values()) {
    for (const g of liste.slice(0, max)) out.push(`  ✗ ${g.nom} — ${g.detail} — ${ou(g.vus)}`);
    if (liste.length > max) out.push(`  … ${liste.length - max} autre(s) « ${liste[0].nom} » (voir --json)`);
  }
  return out;
}

/** Le compte rendu lisible, court : en-tête, une ligne de chiffres par largeur et état, les constats regroupés, les captures. */
export function formater(r, max = DEFAUTS.max) {
  const groupes = constatsGroupes(r);
  const rendu = r.rendu === 'logiciel' ? ' — rendu logiciel (WebGL coupé : ce qu\'il dessine n\'est pas mesuré)' : '';
  const nonMesures = r.passes.filter((p) => p.erreur).length;
  const bilan = nonMesures ? `${nonMesures} passe(s) non mesurée(s) : non vérifié, ` : '';
  const lignes = [`mesures de mise en page — ${r.url} — hauteur ${r.hauteur} px — ${r.date}${rendu}`,
    `${r.passes.length} passe(s), ${bilan}${groupes.length ? `${groupes.length} constat(s)` : 'aucun constat'}, ${r.ecrituresCoupees} écriture(s) coupée(s)`,
    'chiffres :', ...r.passes.map((p) => `  ${ligneChiffres(p)}`)];
  if (groupes.length) lignes.push('constats :', ...lignesConstats(groupes, max));
  for (const p of r.passes.filter((x) => x.capture)) lignes.push(`capture ${p.largeur} ${p.etat} : ${p.capture}`);
  return lignes.join('\n');
}

/** `cadence mesures` : 0 sans constat, 1 avec constats, 2 usage, navigateur introuvable ou passe non mesurée (non vérifié). */
export async function main(argv, io) {
  let o;
  try {
    o = lireOptions(argv);
  } catch (e) {
    io.err(`mesures : ${e.message}`);
    return 2;
  }
  const lance = await lancerNavigateur(io.env, io.cwd);
  if (!lance) {
    io.err('mesures : aucun Playwright chargeable ni navigateur lançable (CADENCE_PLAYWRIGHT, node_modules, serveur MCP Playwright, cache npx) ; rien n\'est installé : non vérifié');
    return 2;
  }
  try {
    const r = await mesurer(lance.navigateur, { ...o, captures: o.captures && resolve(io.cwd, o.captures), rendu: lance.rendu });
    if (o.json) writeFileSync(resolve(io.cwd, o.json), JSON.stringify(r, null, 2) + '\n');
    io.out(formater(r, o.max));
    return codeSortie(r);
  } catch (e) {
    io.err(`mesures : la passe s'est interrompue (${premiereLigne(e)}) : non vérifié`);
    return 2;
  } finally {
    await lance.fermer();
  }
}
