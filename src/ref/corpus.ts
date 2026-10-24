import { createHash } from 'node:crypto';

type Obj = Record<string, any>;

export interface CasCorpus {
  /** Nom du cas = nom du piège qu'il porte (kebab-case) ; slug du document : `corpus-<nom>`. */
  nom: string;
  /** Le document : une `<section class="page">` de 816×1056 px CSS (8,5×11 in) par page. */
  html: string;
  pages: number;
  /** Vrai quand le rendu doit rastériser puis bruiter chaque page (aucune couche texte dans le PDF). */
  scan: boolean;
  /** L'inventaire attendu (genre « inventaire », schéma de `ref check`), vérité de ce qui est dessiné. */
  inventaire: Obj;
}

/** Pixels CSS (96 dpi) → pixels de la page rendue à 200 dpi : le repère des zones d'un inventaire. */
const K = 200 / 96;
interface Boite {
  x: number;
  y: number;
  l: number;
  h: number;
}
const zone = (b: Boite): Boite => ({ x: Math.round(b.x * K), y: Math.round(b.y * K), l: Math.round(b.l * K), h: Math.round(b.h * K) });

const CSS = `@page{size:8.5in 11in;margin:0}html,body{margin:0}
.page{position:relative;width:816px;height:1056px;overflow:hidden;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#111;page-break-after:always}
.page:last-child{page-break-after:auto}.b{position:absolute;box-sizing:border-box}
h1{margin:0;font-size:28px}p{margin:0;font-size:16px}table{border-collapse:collapse;font-size:15px}td,th{border:1px solid #333;padding:6px 10px;text-align:left}th{background:#e6e6e6}`;

const bloc = (b: Boite, contenu: string, style = ''): string => `<div class="b" style="left:${b.x}px;top:${b.y}px;width:${b.l}px;height:${b.h}px;${style}">${contenu}</div>`;
const assemble = (titre: string, pages: string[]): string =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${titre}</title><style>${CSS}</style></head><body>\n${pages.map((p) => `<section class="page">\n${p}\n</section>`).join('\n')}\n</body></html>\n`;

/** Construit l'inventaire d'un cas : ids `corpus-<nom>#<type>-<n>` numérotés par type, zones en repère 200 dpi. */
class Inventaire {
  private n = new Map<string, number>();
  readonly elements: Obj[] = [];
  constructor(private readonly nom: string) {}
  add(type: string, page: number, boite: Boite | undefined, champs: Obj, piege = false): string {
    const k = (this.n.get(type) ?? 0) + 1;
    this.n.set(type, k);
    const id = `corpus-${this.nom}#${type}-${k}`;
    this.elements.push({ type, id, confiance: 'lu', source: boite ? { page, zone: zone(boite) } : { page }, ...champs, ...(piege ? { piege: this.nom } : {}) });
    return id;
  }
  texte(page: number, boite: Boite, libelle: string, role: string, extra: Obj = {}, piege = false): string {
    return this.add('texte', page, boite, { libelle, role, ...extra }, piege);
  }
  /** Écran à la largeur de référence 1440 : la zone « page » couvre toute la page. */
  ecran(page: number): string {
    return this.add('ecran', page, { x: 0, y: 0, l: 816, h: 1056 }, { largeur_reference: 1440, zones: [{ nom: 'page', x: 0, y: 0, l: 1440, h: 1863, pct: { x: 0, y: 0, l: 100, h: 100 } }] });
  }
}

function fini(nom: string, titre: string, pages: string[], inv: Inventaire, scan = false): CasCorpus {
  const html = assemble(titre, pages);
  const inventaire = {
    version: 1,
    genre: 'inventaire',
    document: { slug: `corpus-${nom}`, sha256: createHash('sha256').update(html).digest('hex') },
    pages: pages.length,
    elements: inv.elements,
  };
  return { nom, html, pages: pages.length, scan, inventaire };
}

const TITRE: Boite = { x: 60, y: 50, l: 696, h: 40 };
const PARA: Boite = { x: 60, y: 110, l: 696, h: 24 };
const FIGURE: Boite = { x: 60, y: 170, l: 696, h: 300 };
const LEGENDE: Boite = { x: 60, y: 482, l: 696, h: 24 };

/** Texte ambigu que seule la figure lève : « à côté de la flèche » (tête ou queue ?) ; la figure met l'étiquette à la queue. */
function texteAmbigu(): CasCorpus {
  const nom = 'texte-ambigu-leve-par-figure';
  const inv = new Inventaire(nom);
  const legende = 'Figure 1 — Jet arrow with its speed label';
  const phrase = 'Wind speed is written beside the arrow, in knots (Figure 1).';
  const svg = `<svg width="696" height="300" viewBox="0 0 696 300" xmlns="http://www.w3.org/2000/svg" font-family="Arial,Helvetica,sans-serif">
<defs><marker id="t" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12 z" fill="#111"/></marker></defs>
<line x1="90" y1="160" x2="600" y2="160" stroke="#111" stroke-width="6" marker-end="url(#t)"/>
<text x="90" y="125" font-size="26" font-weight="bold">120 KT</text><text x="90" y="205" font-size="16">tail</text><text x="560" y="205" font-size="16">head</text></svg>`;
  inv.texte(1, TITRE, 'Jet arrow annotation', 'titre');
  inv.texte(1, PARA, phrase, 'paragraphe');
  inv.texte(1, { x: 150, y: 270, l: 90, h: 34 }, '120 KT', 'etiquette-figure');
  inv.texte(1, { x: 150, y: 350, l: 40, h: 20 }, 'tail', 'etiquette-figure');
  inv.texte(1, { x: 620, y: 350, l: 50, h: 20 }, 'head', 'etiquette-figure');
  inv.texte(1, LEGENDE, legende, 'legende');
  inv.add('lien', 1, FIGURE, {
    figure: legende,
    passage: { page: 1, ligne: 2, extrait: 'Wind speed is written beside the arrow' },
    constat: 'precise',
    lecture_ambigue: 'À côté de la flèche : à la tête ou à la queue ?',
    interpretation: "L'étiquette de vitesse se place au-dessus de la queue de la flèche",
    raison: 'Dans la Figure 1, « 120 KT » est écrit au-dessus de la queue (tail), pas de la tête (head)',
  }, true);
  return fini(nom, 'Jet arrow annotation', [bloc(TITRE, '<h1>Jet arrow annotation</h1>') + bloc(PARA, `<p>${phrase}</p>`) + bloc(FIGURE, svg) + bloc(LEGENDE, `<p>${legende}</p>`)], inv);
}

/** Figure qui contredit le texte : le texte donne 80 kt, la figure trace le seuil à 100 kt. */
function figureContredit(): CasCorpus {
  const nom = 'figure-contredit-texte';
  const inv = new Inventaire(nom);
  const legende = 'Figure 1 — Reporting threshold';
  const phrase = 'Turbulence is reported above 80 kt of jet speed (Figure 1).';
  const svg = `<svg width="696" height="300" viewBox="0 0 696 300" xmlns="http://www.w3.org/2000/svg" font-family="Arial,Helvetica,sans-serif">
<rect x="90" y="190" width="420" height="60" fill="#9bb7d4"/><rect x="90" y="110" width="420" height="4" fill="#c0392b"/>
<text x="520" y="120" font-size="22" font-weight="bold">100 kt</text><text x="90" y="280" font-size="18">Jet speed</text></svg>`;
  inv.texte(1, TITRE, 'Turbulence reporting', 'titre');
  inv.texte(1, PARA, phrase, 'paragraphe');
  inv.texte(1, { x: 560, y: 250, l: 100, h: 30 }, '100 kt', 'etiquette-figure');
  inv.texte(1, { x: 90, y: 440, l: 100, h: 24 }, 'Jet speed', 'etiquette-figure');
  inv.texte(1, LEGENDE, legende, 'legende');
  inv.add('lien', 1, FIGURE, {
    figure: legende,
    passage: { page: 1, ligne: 2, extrait: 'Turbulence is reported above 80 kt' },
    constat: 'contredit',
    enonces: ['Texte : la turbulence est signalée au-dessus de 80 kt', 'Figure 1 : le seuil est tracé à 100 kt'],
  }, true);
  return fini(nom, 'Turbulence reporting', [bloc(TITRE, '<h1>Turbulence reporting</h1>') + bloc(PARA, `<p>${phrase}</p>`) + bloc(FIGURE, svg) + bloc(LEGENDE, `<p>${legende}</p>`)], inv);
}

/** Table en image : dessinée en HTML puis rastérisée au rendu, absente de la couche texte du PDF. */
function tableEnImage(): CasCorpus {
  const nom = 'table-en-image';
  const inv = new Inventaire(nom);
  const colonnes = ['Code', 'Meaning', 'Oktas'];
  const lignes = [['0', 'Clear', '0'], ['1', 'Few', '1-2'], ['3', 'Scattered', '3-4'], ['5', 'Broken', '5-7'], ['8', 'Overcast', '8']];
  const legende = 'Table 1 — Cloud amount';
  const phrase = 'The codes are listed in Table 1.';
  const zoneTable: Boite = { x: 60, y: 190, l: 400, h: 230 };
  const html = `<table class="raster"><tr>${colonnes.map((c) => `<th>${c}</th>`).join('')}</tr>${lignes.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  inv.texte(1, TITRE, 'Cloud amount codes', 'titre');
  inv.texte(1, PARA, phrase, 'paragraphe');
  inv.texte(1, { x: 60, y: 156, l: 300, h: 24 }, legende, 'legende');
  inv.add('table', 1, zoneTable, { colonnes, lignes }, true);
  return fini(nom, 'Cloud amount codes', [bloc(TITRE, '<h1>Cloud amount codes</h1>') + bloc(PARA, `<p>${phrase}</p>`) + bloc({ x: 60, y: 156, l: 300, h: 24 }, `<p>${legende}</p>`) + bloc(zoneTable, html)], inv);
}

/** Gabarit de type BUFR (section 1) : champs ordonnés, obligatoires ou facultatifs, format et bornes. */
function gabaritBufr(): CasCorpus {
  const nom = 'gabarit-type-bufr';
  const inv = new Inventaire(nom);
  const champs = [
    { octets: '1-3', nom: 'Length of section', format: 'uint24', statut: 'Mandatory', min: 0, max: 16777215 },
    { octets: '4', nom: 'Master table', format: 'uint8', statut: 'Mandatory', min: 0, max: 255 },
    { octets: '5-6', nom: 'Originating centre', format: 'uint16', statut: 'Mandatory', min: 0, max: 65535 },
    { octets: '7', nom: 'Update sequence', format: 'uint8', statut: 'Optional', min: 0, max: 255 },
    { octets: '8', nom: 'Optional section flag', format: 'bit', statut: 'Optional', min: 0, max: 1 },
  ];
  const zoneTable: Boite = { x: 60, y: 130, l: 696, h: 250 };
  const rangs = champs.map((c) => `<tr><td>${c.octets}</td><td>${c.nom}</td><td>${c.format}</td><td>${c.statut}</td><td>${c.min}-${c.max}</td></tr>`).join('');
  const html = `<table><tr><th>Octet</th><th>Field</th><th>Format</th><th>Status</th><th>Range</th></tr>${rangs}</table>`;
  inv.texte(1, TITRE, 'BUFR section 1', 'titre');
  inv.add('gabarit', 1, zoneTable, { nom: 'BUFR section 1', champs: champs.map((c) => ({ nom: c.nom, obligatoire: c.statut === 'Mandatory', format: c.format, min: c.min, max: c.max })) }, true);
  return fini(nom, 'BUFR section 1', [bloc(TITRE, '<h1>BUFR section 1</h1>') + bloc(zoneTable, html)], inv);
}

/** Contrôle translucide sur fond chargé : un bouton blanc à 25 % d'opacité sur une carte à bandes, à côté d'un bouton opaque. */
function controleTranslucide(): CasCorpus {
  const nom = 'controle-translucide';
  const inv = new Inventaire(nom);
  const fond = 'background:linear-gradient(135deg,#0b3d91 0%,#2e8b57 50%,#f2c14e 100%),repeating-linear-gradient(45deg,#ffffff 0 10px,#000000 10px 20px);background-blend-mode:multiply;';
  const layers: Boite = { x: 300, y: 400, l: 160, h: 44 };
  const zoom: Boite = { x: 500, y: 400, l: 120, h: 44 };
  const ecran = inv.ecran(1);
  inv.add('composant', 1, layers, { role: 'bouton', position: { x: Math.round(layers.x * K), y: Math.round(layers.y * K) }, taille: { l: Math.round(layers.l * K), h: Math.round(layers.h * K) }, contenu: 'Layers', ecran });
  inv.add('composant', 1, zoom, { role: 'bouton', position: { x: Math.round(zoom.x * K), y: Math.round(zoom.y * K) }, taille: { l: Math.round(zoom.l * K), h: Math.round(zoom.h * K) }, contenu: 'Zoom', ecran });
  inv.texte(1, { x: 340, y: 410, l: 90, h: 24 }, 'Layers', 'bouton');
  inv.texte(1, { x: 535, y: 410, l: 60, h: 24 }, 'Zoom', 'bouton');
  inv.add('jeton', 1, layers, { categorie: 'opacite', valeur: '0.25', point: { x: Math.round((layers.x + 10) * K), y: Math.round((layers.y + 10) * K) } }, true);
  inv.add('jeton', 1, zoom, { categorie: 'couleur', valeur: '#1e3a8a', point: { x: Math.round((zoom.x + 10) * K), y: Math.round((zoom.y + 10) * K) } });
  const bouton = (b: Boite, texte: string, style: string) => bloc(b, `<span style="font-size:18px;color:#fff;line-height:44px">${texte}</span>`, `text-align:center;border-radius:6px;${style}`);
  const page = bloc({ x: 0, y: 0, l: 816, h: 1056 }, '', fond) + bouton(layers, 'Layers', 'background:rgba(255, 255, 255, 0.25);') + bouton(zoom, 'Zoom', 'background:#1e3a8a;');
  return fini(nom, 'Map controls', [page], inv);
}

/** Page « Proposal » parmi des pages exigées : les exigences (page 1) et une maquette de panneau marquée Proposal (page 2). */
function pageProposal(): CasCorpus {
  const nom = 'page-proposal';
  const inv = new Inventaire(nom);
  const exigences = ['REQ-1 The map shall show the layer panel.', 'REQ-2 The panel shall list every active layer.'];
  const panneau: Boite = { x: 60, y: 160, l: 300, h: 420 };
  const badge: Boite = { x: 600, y: 50, l: 150, h: 36 };
  inv.texte(1, TITRE, 'Requirements', 'titre');
  exigences.forEach((t, i) => inv.texte(1, { x: 60, y: 110 + i * 40, l: 696, h: 24 }, t, 'exigence'));
  const ecran = inv.ecran(2);
  inv.texte(2, { x: 60, y: 50, l: 400, h: 40 }, 'Layer panel mock-up', 'titre');
  const comp = inv.add('composant', 2, panneau, { role: 'panneau', position: { x: Math.round(panneau.x * K), y: Math.round(panneau.y * K) }, taille: { l: Math.round(panneau.l * K), h: Math.round(panneau.h * K) }, contenu: 'Layers', ecran });
  inv.texte(2, { x: 80, y: 176, l: 100, h: 26 }, 'Layers', 'titre-panneau');
  inv.add('statut', 2, badge, { libelle: 'Proposal', couvre: [comp] }, true);
  const page1 = bloc(TITRE, '<h1>Requirements</h1>') + exigences.map((t, i) => bloc({ x: 60, y: 110 + i * 40, l: 696, h: 24 }, `<p>${t}</p>`)).join('');
  const page2 =
    bloc({ x: 60, y: 50, l: 400, h: 40 }, '<h1>Layer panel mock-up</h1>') +
    bloc(badge, '<span style="font-size:18px;font-weight:bold;color:#fff;line-height:36px">Proposal</span>', 'background:#e67e22;border-radius:18px;text-align:center') +
    bloc(panneau, '<p style="font-size:20px;font-weight:bold;margin:16px 20px">Layers</p>', 'background:#f4f4f4;border:2px solid #333');
  return fini(nom, 'Layer panel', [page1, page2], inv);
}

/** Version scannée : une fiche de station dessinée puis rastérisée, bruitée et légèrement penchée au rendu ; texte attendu issu d'un OCR. */
function scanBruite(): CasCorpus {
  const nom = 'scan-bruite';
  const inv = new Inventaire(nom);
  const lignes = ['Station: LFPG', 'Visibility: 9999 m', 'Wind: 240/12 KT'];
  inv.texte(1, TITRE, 'Station report', 'titre', { ocr: true }, true);
  lignes.forEach((t, i) => inv.texte(1, { x: 60, y: 130 + i * 50, l: 400, h: 30 }, t, 'ligne', { ocr: true }, true));
  const page = bloc(TITRE, '<h1>Station report</h1>') + lignes.map((t, i) => bloc({ x: 60, y: 130 + i * 50, l: 400, h: 30 }, `<p style="font-size:22px">${t}</p>`)).join('');
  return fini(nom, 'Station report', [page], inv, true);
}

/** Le corpus synthétique à vérité connue : un cas par piège de la conception, dans l'ordre (design « Évaluation »). */
export function buildCorpus(): CasCorpus[] {
  return [texteAmbigu(), figureContredit(), tableEnImage(), gabaritBufr(), controleTranslucide(), pageProposal(), scanBruite()];
}
