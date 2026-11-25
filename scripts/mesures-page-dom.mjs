// Mesures de mise en page (L839, demande D-34) : la partie qui tourne DANS la page. Chaque fonction ci-dessous est recopiée telle quelle dans
// SCRIPT_MESURES, évalué après le chargement : elles s'appellent par leur nom et ne lisent rien du module. Pas de dépendance, rien de propre
// à un projet. Côté Node : scripts/mesures-page.mjs. Ce qui est mesuré et pourquoi : docs/mesures-page.md.

/** Les libellés courts qui ne devraient pas passer à la ligne : contrôles, onglets, en-têtes de colonnes, légendes de champ. */
const LIBELLES = 'button,label,th,summary,legend,dt,[role=button],[role=tab],[role=menuitem],[role=option],[role=link],a';
/** Ce qu'un utilisateur peut viser du doigt ou du pointeur (WCAG 2.5.8). */
const CIBLES = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[tabindex]:not([tabindex="-1"])';
/** Une valeur, puis une unité courte : « 12 km/h », « 3,5 m », « 20 % », « 1013 hPa ». */
const NOMBRE = /^[−+-]?\d[\d.,]*$/;
const UNITE = /^(%|‰|°[A-Za-z]?|[A-Za-zµ°/²³·]{1,6})[.,;:)]?$/;

function mpVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
}

/** Un nom court et stable : balise, data-testid ou id, deux classes au plus. */
function mpSel(el) {
  const testid = el.getAttribute('data-testid');
  if (testid) return `${el.tagName.toLowerCase()}[data-testid="${testid}"]`;
  if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
  const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  return el.tagName.toLowerCase() + classes.map((c) => `.${c}`).join('');
}

function mpTexte(el) {
  return String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Les lignes d'une suite de rectangles : leurs hauts distincts, à 3 px près. */
function mpLignes(rects) {
  const hauts = [];
  for (const r of rects) {
    if (r.width < 1 || r.height < 1) continue;
    if (!hauts.some((h) => Math.abs(h - r.top) < 3)) hauts.push(r.top);
  }
  return hauts.length;
}

/** Un ancêtre qui coupe ou fait défiler en largeur : ce qui déborde dedans ne fait pas défiler la page. */
function mpDansUnDefileur(el) {
  for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const ox = getComputedStyle(a).overflowX;
    if (ox !== 'visible') return true;
  }
  return false;
}

/** Les éléments les plus extérieurs qui dépassent le bord droit de la vue sans être dans un défileur : ce qui fait défiler la page en largeur. */
function mpDebordements(vw) {
  const vus = [];
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 || !mpVisible(el) || getComputedStyle(el).position === 'fixed' || mpDansUnDefileur(el)) continue;
    if (vus.some((v) => v.contains(el))) continue;
    vus.push(el);
    out.push({ sel: mpSel(el), px: Math.round(r.right - vw), largeur: Math.round(r.width), texte: mpTexte(el) });
  }
  return out.sort((a, b) => b.px - a.px);
}

/** Les textes coupés par leur boîte (overflow caché, ellipse) : on n'en lit qu'une partie. */
function mpTronques() {
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    if (s.overflowX === 'visible' && s.textOverflow !== 'ellipsis') continue;
    if (el.scrollWidth <= el.clientWidth + 1 || !mpVisible(el)) continue;
    out.push({ sel: mpSel(el), visible: el.clientWidth, contenu: el.scrollWidth, texte: mpTexte(el) });
  }
  return out;
}

/** Où un mot passe à la ligne : le caractère avant la coupure dit s'il s'agit d'un trait d'union ou d'une coupure entre deux lettres. */
function mpOuCoupe(noeud, debut, mot) {
  const r = document.createRange();
  let haut = null;
  for (let i = 0; i < mot.length; i++) {
    r.setStart(noeud, debut + i);
    r.setEnd(noeud, debut + i + 1);
    const rect = r.getClientRects()[0];
    if (!rect) continue;
    if (haut !== null && Math.abs(rect.top - haut) >= 3) return { apres: mot.slice(0, i), avant: mot.slice(i) };
    haut = rect.top;
  }
  return { apres: mot, avant: '' };
}

function mpRectsMot(noeud, debut, fin) {
  const r = document.createRange();
  r.setStart(noeud, debut);
  r.setEnd(noeud, fin);
  return [...r.getClientRects()];
}

/** Les nœuds texte visibles de la page, hors script, style et champs. */
function mpNoeudsTexte() {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (!p || !n.textContent.trim() || p.closest('script,style,noscript,textarea,svg') || !mpVisible(p)) continue;
    out.push(n);
  }
  return out;
}

/** Un mot sur deux lignes (coupure) et une valeur séparée de son unité par un passage à la ligne. */
function mpMotsDuNoeud(n, plafond, acc) {
  const mots = [...n.textContent.matchAll(/\S+/g)];
  let precedent = null;
  for (const m of mots) {
    if (acc.mots >= plafond) { acc.plafond = true; return; }
    acc.mots += 1;
    const rects = mpRectsMot(n, m.index, m.index + m[0].length);
    const haut = rects.find((r) => r.width >= 1)?.top;
    if (m[0].length >= 2 && mpLignes(rects) > 1) {
      const { apres, avant } = mpOuCoupe(n, m.index, m[0]);
      acc.coupures.push({ sel: mpSel(n.parentElement), mot: m[0], coupe: `${apres}|${avant}`, trait: /[-‐‑/_­]$/.test(apres) });
    }
    if (precedent && haut !== undefined && NOMBRE.test(precedent.mot) && UNITE.test(m[0]) && Math.abs(haut - precedent.haut) >= 3) {
      acc.separees.push({ sel: mpSel(n.parentElement), valeur: precedent.mot, unite: m[0] });
    }
    precedent = haut === undefined ? null : { mot: m[0], haut };
  }
}

function mpMots(plafond) {
  const acc = { mots: 0, plafond: false, coupures: [], separees: [] };
  for (const n of mpNoeudsTexte()) {
    mpMotsDuNoeud(n, plafond, acc);
    if (acc.plafond) break;
  }
  return acc;
}

/** Un lien dans une phrase passe à la ligne comme la phrase : seul compte un lien qui est seul dans son parent. */
function mpLibelleIsole(el) {
  if (el.tagName !== 'A') return true;
  return ![...(el.parentElement?.childNodes ?? [])].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim());
}

/** Les libellés courts (30 caractères au plus) qui tiennent sur plusieurs lignes. */
function mpSautsDeLigne() {
  const out = [];
  for (const el of document.body.querySelectorAll(LIBELLES)) {
    const texte = mpTexte(el);
    if (!texte || texte.length > 30 || !mpVisible(el) || !mpLibelleIsole(el)) continue;
    const r = document.createRange();
    r.selectNodeContents(el);
    const lignes = mpLignes(r.getClientRects());
    if (lignes > 1) out.push({ sel: mpSel(el), lignes, largeur: Math.round(el.getBoundingClientRect().width), texte });
  }
  return out;
}

/** Les cibles de moins de 24 × 24 px (WCAG 2.5.8, sans l'exception d'espacement, que la revue juge sur la capture). */
function mpCibles() {
  const out = [];
  for (const el of document.body.querySelectorAll(CIBLES)) {
    if (!mpVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    if (el.tagName === 'A' && !mpLibelleIsole(el)) continue; // un lien dans une phrase est exempté (WCAG 2.5.8, « inline »)
    out.push({ sel: mpSel(el), largeur: Math.round(r.width), hauteur: Math.round(r.height), texte: mpTexte(el) || el.getAttribute('aria-label') || '' });
  }
  return out;
}

/** La plus petite taille de texte affichée, et le nombre de nœuds texte sous 12 px. */
function mpPolices(noeuds) {
  let min = Infinity;
  let petits = 0;
  for (const n of noeuds) {
    const px = parseFloat(getComputedStyle(n.parentElement).fontSize);
    if (px < min) min = px;
    if (px < 12) petits += 1;
  }
  return { min: Number.isFinite(min) ? min : null, sous12: petits };
}

/** L'enveloppe : la vue, le document et les repères (en-tête, navigation, contenu, côté, pied), avec leurs gouttières. */
function mpLargeurs(vw) {
  const vus = [];
  const reperes = [];
  for (const el of document.querySelectorAll('header,nav,main,aside,footer,[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo]')) {
    if (!mpVisible(el) || vus.some((v) => v.contains(el))) continue;
    vus.push(el);
    const r = el.getBoundingClientRect();
    reperes.push({ sel: mpSel(el), gauche: Math.round(r.left), largeur: Math.round(r.width), droite: Math.round(vw - r.right) });
  }
  return reperes;
}

/** Toutes les mesures de la page, en un appel. */
function mpMesurer(plafondMots) {
  const vw = document.documentElement.clientWidth;
  const doc = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  const mots = mpMots(plafondMots);
  return {
    vue: vw, document: doc, defilementHorizontal: Math.max(0, doc - vw), reperes: mpLargeurs(vw), debordements: mpDebordements(vw),
    tronques: mpTronques(), coupures: mots.coupures, separees: mots.separees, motsLus: mots.mots, plafondAtteint: mots.plafond,
    sautsDeLigne: mpSautsDeLigne(), cibles: mpCibles(), polices: mpPolices(mpNoeudsTexte()),
  };
}

const FONCTIONS = [mpVisible, mpSel, mpTexte, mpLignes, mpDansUnDefileur, mpDebordements, mpTronques, mpOuCoupe, mpRectsMot, mpNoeudsTexte, mpMotsDuNoeud,
  mpMots, mpLibelleIsole, mpSautsDeLigne, mpCibles, mpPolices, mpLargeurs, mpMesurer];

/** Le code évalué dans la page : il pose `window.__mesures` puis rend les mesures (`plafond` = mots lus au plus). */
export const scriptMesures = (plafond) => `(() => {
const LIBELLES = ${JSON.stringify(LIBELLES)};
const CIBLES = ${JSON.stringify(CIBLES)};
const NOMBRE = ${NOMBRE.toString()};
const UNITE = ${UNITE.toString()};
${FONCTIONS.map((f) => f.toString()).join('\n')}
return mpMesurer(${Number(plafond)});
})()`;
