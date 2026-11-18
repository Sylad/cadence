// Sondes d'interaction (L778, demande D-14) : la partie qui tourne DANS la page. Chaque fonction ci-dessous est recopiée telle quelle dans un script
// d'initialisation (SCRIPT_SONDES) : elles s'appellent par leur nom et ne lisent rien du module. Pas de dépendance, rien de propre à un projet.
// Côté Node : scripts/sondes-interaction.mjs. Méthode et seuils : docs/sondes-interaction.md.

/** Ce qu'un utilisateur peut cocher, basculer ou presser. */
const CONTROLES = 'input[type=checkbox],input[type=radio],[role=checkbox],[role=switch],[role=radio],[role=menuitemcheckbox],[role=menuitemradio],[aria-pressed],'
  + 'button,[role=button],summary';
/** Un bouton qui écrit, envoie, efface ou navigue hors de la session n'est jamais pressé par une sonde. */
const RISQUE = /\b(suppr|delete|remove|retir|effac|clear|reset|r[ée]initiali|vider|envoy|send|submit|valider|validate|confirm|enregistr|save|publier|publish|pay|achet|buy|commander|logout|log out|d[ée]connex|sign ?out|sign ?up|sign ?in|inscri|login|connexion|install|t[ée]l[ée]charg|download|export|imprim|print|partag|share|copy|copier)/i;

function sdVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

/** Une bascule : sa valeur cochée, pressée, ouverte ou dépliée change au clic. */
function sdEstBascule(el) {
  return el.matches('input[type=checkbox],input[type=radio],[role=checkbox],[role=switch],[role=radio],[role=menuitemcheckbox],[role=menuitemradio],[aria-pressed]');
}

function sdNom(el) {
  const lab = el.labels && el.labels[0];
  const t = el.getAttribute('aria-label') || (lab && lab.innerText) || el.innerText || el.getAttribute('title') || el.value || '';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** L'ancêtre (6 niveaux au plus) qui se répète chez ses frères : la ligne d'une liste, même sans `<li>`. */
function sdLigne(el) {
  const semantique = el.closest('li,[role=listitem],[role=treeitem],[role=option],[role=row],tr,dd');
  if (semantique) return semantique;
  let a = el.parentElement;
  for (let i = 0; a && a.parentElement && i < 6; i++, a = a.parentElement) {
    const sig = a.tagName + '.' + a.className;
    const freres = [...a.parentElement.children].filter((f) => f.tagName + '.' + f.className === sig && f.querySelector(CONTROLES));
    if (freres.length >= 2) return a;
  }
  return null;
}

function sdRisque(el) {
  if (el.closest('a[href]') || el.matches('[type=submit],[type=reset]')) return true;
  const form = el.closest('form');
  if (form && !sdEstBascule(el) && (form.method || '').toLowerCase() === 'post') return true;
  return RISQUE.test(sdNom(el)) || RISQUE.test(el.className && typeof el.className === 'string' ? el.className : '');
}

/** Couvert : son centre est dans la vue mais un autre élément (un panneau replié, une carte) y reçoit le clic. Hors de la vue, la sonde le fera défiler. */
function sdCouvert(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
  const haut = document.elementFromPoint(x, y);
  const label = el.labels && el.labels[0];
  return !(haut && (el.contains(haut) || haut.contains(el) || (label && label.contains(haut))));
}

/**
 * Un contrôle que la sonde presserait : visible, actif, sans risque ; rend sa ligne de liste (ou null), la clé de sa liste, et s'il est couvert
 * (revue r1 : un couvert n'est pas pressé mais il est rendu, pour que le rapport le compte comme non mesurable au lieu de l'oublier).
 */
function sdCandidat(el) {
  if (!sdVisible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || sdRisque(el)) return null;
  const ligne = sdLigne(el);
  const dialogue = el.matches('[aria-haspopup]') && el.getAttribute('aria-haspopup') !== 'false';
  if (!sdEstBascule(el) && !ligne && !dialogue) return null;
  return { ligne, cle: ligne && ligne.parentElement ? ligne.parentElement : el.parentElement, couvert: sdCouvert(el) };
}

/**
 * Marque (data-sonde-id) les contrôles à sonder : toute bascule visible, tout bouton d'une liste ou qui ouvre un dialogue, jamais un contrôle risqué.
 * Au plus `parListe` par liste et `max` en tout, dans l'ordre du document. Rend { controles: [{ id, nom, role, liste }], couverts: [{ nom, role, liste }] } :
 * les couverts (au plus `max`) ne sont pas pressés, le rapport les compte comme non mesurables.
 */
function sdMarquer(max, parListe) {
  const parListeVus = new Map();
  const out = [];
  const couverts = [];
  for (const el of document.querySelectorAll(CONTROLES)) {
    if (out.length >= max) break;
    const c = sdCandidat(el);
    if (!c) continue;
    if (c.couvert) {
      if (couverts.length < max) couverts.push(sdFiche(el, c));
      continue;
    }
    const n = parListeVus.get(c.cle) || 0;
    if (n >= parListe) continue;
    parListeVus.set(c.cle, n + 1);
    const id = String(out.length + 1);
    el.setAttribute('data-sonde-id', id);
    out.push({ id, ...sdFiche(el, c) });
  }
  return { controles: out, couverts };
}

/** Ce que le rapport dit d'un contrôle : son nom, bascule ou bouton, et s'il est dans une liste. */
function sdFiche(el, c) {
  return { nom: sdNom(el), role: sdEstBascule(el) ? 'bascule' : 'bouton', liste: !!c.ligne };
}

function sdDefilements() {
  const out = [{ cible: 'window', x: Math.round(scrollX), y: Math.round(scrollY) }];
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue;
    const s = getComputedStyle(el);
    if (!/auto|scroll|overlay/.test(s.overflowY + s.overflowX)) continue;
    out.push({ cible: sdDecrire(el), x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop), el });
  }
  return out;
}

function sdDecrire(el) {
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
}

function sdDialogues() {
  return [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')].filter(sdVisible);
}

function sdEtat(el) {
  return [el.checked, el.getAttribute('aria-checked'), el.getAttribute('aria-pressed'), el.getAttribute('aria-expanded'), el.closest('details') && el.closest('details').open].join('|');
}

/** Avant le clic : la place de l'élément, les défilements, les dialogues ouverts, et un observateur des changements du DOM. Rend '' ou la raison de ne pas cliquer. */
function sdAvant(id) {
  const el = document.querySelector(`[data-sonde-id="${id}"]`);
  if (!el) return 'élément disparu avant le clic';
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return 'hors de portée : le défilement ne l\'amène pas dans la vue';
  if (sdCouvert(el)) return 'couvert par un autre élément après défilement';
  const changes = [];
  const obs = new MutationObserver((recs) => { for (const r of recs) changes.push(r); });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__sondeEtat = { id, el, sig: sdSignature(el), top: el.getBoundingClientRect().top, defil: sdDefilements(), dialogues: sdDialogues(), etat: sdEtat(el), changes, obs, url: location.href };
  return '';
}

/** Ce qui reconnaît un contrôle quand le clic l'a remplacé par un nœud neuf (liste reconstruite sans clé stable) : balise, type, id, name, nom. */
function sdSignature(el) {
  return { tag: el.tagName, type: el.getAttribute('type') || '', id: el.id, name: el.getAttribute('name') || '', role: el.getAttribute('role') || '', nom: sdNom(el) };
}

/** L'équivalent unique d'un contrôle remplacé, ou le nombre d'équivalents trouvés quand il n'y en a pas exactement un. */
function sdEquivalent(sig) {
  const memes = [...document.getElementsByTagName(sig.tag)].filter((e) => sdVisible(e) && (e.getAttribute('type') || '') === sig.type && e.id === sig.id
    && (e.getAttribute('name') || '') === sig.name && (e.getAttribute('role') || '') === sig.role && sdNom(e) === sig.nom);
  return memes.length === 1 ? { el: memes[0], nombre: 1 } : { el: null, nombre: memes.length };
}

/** Les éléments touchés par les changements du DOM, hors de l'élément cliqué et de ses ancêtres (un nœud retiré compte par son parent). */
function sdTouches(el, recs) {
  const vues = new Set();
  for (const r of recs) {
    const ajouts = r.type === 'childList' ? [...r.addedNodes] : [];
    for (const n of ajouts.length ? ajouts : [r.target]) {
      const e = n.nodeType === 1 ? n : n.parentElement;
      if (e && e.isConnected && !e.contains(el) && !el.contains(e)) vues.add(e);
    }
  }
  return vues;
}

/** Une région changée vue depuis le rectangle `b` de l'élément cliqué : distance (px, entre les bords), côté, description. */
function sdRegion(e, r, b) {
  const dy = Math.max(0, r.top - b.bottom, b.top - r.bottom);
  const dx = Math.max(0, r.left - b.right, b.left - r.right);
  let cote = 'à côté';
  if (r.bottom <= b.top) cote = 'au-dessus';
  else if (r.top >= b.bottom) cote = 'en dessous';
  return { distance: Math.round(Math.hypot(dx, dy)), cote, region: sdDecrire(e), texte: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
}

/** Les régions qui ont changé : la plus proche de l'élément, la plus proche au-dessus (ce qui pousse l'élément vers le bas), et si aucune n'est visible. */
function sdRegions(el, recs) {
  const b = el.getBoundingClientRect();
  let proche = null;
  let dessus = null;
  let mesurees = 0;
  let visibles = 0;
  for (const e of sdTouches(el, recs)) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    mesurees += 1;
    if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) visibles += 1;
    const ici = sdRegion(e, r, b);
    if (!proche || ici.distance < proche.distance) proche = ici;
    if (ici.cote === 'au-dessus' && (!dessus || ici.distance < dessus.distance)) dessus = ici;
  }
  return { proche, dessus, horsVue: mesurees > 0 && visibles === 0, nombre: mesurees };
}

function sdDefilementSubi(avant) {
  const subis = [];
  for (const d of avant) {
    const x = d.el ? d.el.scrollLeft : scrollX;
    const y = d.el ? d.el.scrollTop : scrollY;
    if ((d.el && !d.el.isConnected) || (Math.abs(x - d.x) < 1 && Math.abs(y - d.y) < 1)) continue;
    subis.push({ cible: d.cible, dx: Math.round(x - d.x), dy: Math.round(y - d.y) });
  }
  return subis;
}

/**
 * Après le clic : suit l'élément image par image pendant `ms`, puis rend le saut (max et final), le défilement subi, la région changée, le dialogue ouvert.
 * Un élément remplacé par le clic (nœud détaché) est suivi par son équivalent unique (sdEquivalent), qui reçoit son data-sonde-id pour le second clic ;
 * sans équivalent unique, le saut est non mesurable (revue r1), jamais nul. Sans état (document neuf après une navigation) : { etatPerdu: true }.
 */
async function sdApres(ms) {
  const s = window.__sondeEtat;
  if (!s) return { etatPerdu: true };
  let el = s.el;
  let max = 0;
  const suivre = () => {
    if (el.isConnected) return true;
    const q = sdEquivalent(s.sig);
    if (q.el) el = q.el;
    return !!q.el;
  };
  const fin = performance.now() + ms;
  while (performance.now() < fin) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    if (suivre()) {
      const d = el.getBoundingClientRect().top - s.top;
      if (Math.abs(d) > Math.abs(max)) max = d;
    }
  }
  s.obs.disconnect();
  const connecte = suivre();
  const remplace = el !== s.el;
  if (remplace && connecte) el.setAttribute('data-sonde-id', s.id);
  const neuf = sdDialogues().find((d) => !s.dialogues.includes(d));
  if (neuf) window.__sondeDialogue = { d: neuf, declencheur: el };
  const commun = {
    connecte,
    remplace,
    defilement: sdDefilementSubi(s.defil),
    navigation: location.href !== s.url,
    dialogue: neuf ? { nom: sdNom(neuf) || sdDecrire(neuf), focusDedans: neuf.contains(document.activeElement) } : null,
  };
  if (!connecte) {
    return { ...commun, sautMax: null, sautFinal: null, regions: null, etatChange: false,
      nonMesure: `élément remplacé par le clic, ${sdEquivalent(s.sig).nombre} équivalent(s) visible(s) au lieu d'un : saut non mesurable` };
  }
  return {
    ...commun,
    sautMax: Math.round(max * 10) / 10,
    sautFinal: Math.round((el.getBoundingClientRect().top - s.top) * 10) / 10,
    regions: sdRegions(el, s.changes),
    etatChange: sdEtat(el) !== s.etat,
  };
}

/** Après Échap : le dialogue ouvert par la sonde est-il fermé, et le focus rendu à ce qui l'a ouvert ? */
function sdApresEchap() {
  const o = window.__sondeDialogue;
  if (!o) return null;
  window.__sondeDialogue = null;
  const ferme = !o.d.isConnected || !sdVisible(o.d) || (o.d.tagName === 'DIALOG' && !o.d.open);
  return { ferme, focusRendu: document.activeElement === o.declencheur };
}

/** Le défilement « au repos » : relevé, attente de `ms` sans aucun geste, puis ce qui a bougé seul. */
async function sdRepos(ms) {
  const avant = sdDefilements();
  await new Promise((r) => setTimeout(r, ms));
  return sdDefilementSubi(avant);
}

/** Marque les `n` premiers éléments visibles du sélecteur (étape « cliquer » d'un parcours) ; rend leurs ids. */
function sdMarquerSelecteur(sel, n, prefixe) {
  const ids = [];
  for (const el of document.querySelectorAll(sel)) {
    if (ids.length >= n) break;
    if (!sdVisible(el)) continue;
    const id = `${prefixe}-${ids.length + 1}`;
    el.setAttribute('data-sonde-id', id);
    ids.push({ id, nom: sdNom(el) });
  }
  return ids;
}

const FONCTIONS = [sdVisible, sdEstBascule, sdNom, sdLigne, sdRisque, sdCouvert, sdCandidat, sdMarquer, sdFiche, sdDefilements, sdDecrire, sdDialogues, sdEtat, sdAvant, sdSignature,
  sdEquivalent, sdTouches, sdRegion, sdRegions, sdDefilementSubi, sdApres, sdApresEchap, sdRepos, sdMarquerSelecteur];

/** Le script d'initialisation : les constantes et les fonctions ci-dessus, exposées sous window.__sondes. */
export const SCRIPT_SONDES = `(() => {
const CONTROLES = ${JSON.stringify(CONTROLES)};
const RISQUE = ${RISQUE.toString()};
${FONCTIONS.map((f) => f.toString()).join('\n')}
window.__sondes = { ${FONCTIONS.map((f) => f.name).join(', ')} };
})();`;

/**
 * Lecture seule, dans la page (revue r1) : les voies d'écriture que le routage réseau de Playwright ne voit pas ou ne coupe pas seul. `sendBeacon`
 * rend false, `RTCPeerConnection` et `WebTransport` lèvent ; chaque tentative est notée par la liaison `__sondesEcriture` (voie, détail).
 * HTTP non GET est coupé au réseau du navigateur et les workers sont gardés à leur démarrage (scripts/sondes-garde.mjs) ; les messages WebSocket de la
 * page et de ses iframes sont coupés par le routage du contexte (scripts/sondes-interaction.mjs, couperLesEcritures). Ce script ne court pas dans les workers.
 */
export const SCRIPT_LECTURE_SEULE = `(() => {
const noter = (voie, detail) => { try { window.__sondesEcriture && window.__sondesEcriture(voie, String(detail).slice(0, 80)); } catch (e) { /* rien */ } };
if (navigator.sendBeacon) {
  const balise = function sendBeacon(url, data) { noter('sendBeacon', 'POST ' + url + (data === undefined ? '' : ' « ' + String(data) + ' »')); return false; };
  try { Object.defineProperty(Navigator.prototype, 'sendBeacon', { configurable: true, writable: true, value: balise }); } catch (e) { /* rien */ }
}
for (const nom of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
  if (!(nom in window)) continue;
  const bloque = function () { noter(nom, (arguments[0] && typeof arguments[0] === 'string') ? arguments[0] : ''); throw new DOMException(nom + ' bloqué : sondes en lecture seule', 'SecurityError'); };
  try { Object.defineProperty(window, nom, { configurable: true, writable: true, value: bloque }); } catch (e) { /* rien */ }
}
})();`;
