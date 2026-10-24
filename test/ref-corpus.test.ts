import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { checkInventaire } from '../src/ref/check.js';
import { buildCorpus } from '../src/ref/corpus.js';
import { tempDir } from './helpers.js';

type Obj = Record<string, any>;

const PIEGES = ['texte-ambigu-leve-par-figure', 'figure-contredit-texte', 'table-en-image', 'gabarit-type-bufr', 'controle-translucide', 'page-proposal', 'scan-bruite'];
const corpus = buildCorpus();
const cas = (nom: string) => corpus.find((c) => c.nom === nom)!;
const elements = (nom: string, type: string): Obj[] => cas(nom).inventaire.elements.filter((e: Obj) => e.type === type);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

function corpusCmd(args: string[], env: NodeJS.ProcessEnv = {}) {
  const dir = tempDir();
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['ref', 'corpus', join(dir, 'corpus'), ...args], { cwd: dir, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-24T10:00:00') });
  return Promise.resolve(code).then((c) => ({ code: c, out: out.join('\n'), err: err.join('\n'), dir: join(dir, 'corpus') }));
}

describe('cadence ref corpus — le corpus synthétique à vérité connue (evals/ref)', () => {
  it('R1 — le corpus a un cas par piège de la conception, dans cet ordre', () => {
    expect(corpus.map((c) => c.nom)).toEqual(PIEGES);
  });

  it('R2 — l’inventaire attendu de chaque cas passe cadence ref check, à ses slug et empreinte', () => {
    for (const c of corpus) {
      expect(checkInventaire(c.inventaire), c.nom).toEqual([]);
      expect(c.inventaire.genre).toBe('inventaire');
      expect(c.inventaire.document.slug).toBe(`corpus-${c.nom}`);
      expect(c.inventaire.document.sha256).toBe(createHash('sha256').update(c.html).digest('hex'));
      expect(c.inventaire.pages).toBe(c.pages);
    }
  });

  it('R3 — le corpus est déterministe : deux générations donnent les mêmes pages et les mêmes attendus', () => {
    expect(JSON.stringify(buildCorpus())).toBe(JSON.stringify(corpus));
  });

  it('R4 — chaque cas marque d’un « piege » (son nom) au moins un élément de son inventaire, et aucun autre piège', () => {
    for (const c of corpus) {
      const marques = c.inventaire.elements.filter((e: Obj) => e.piege !== undefined);
      expect(marques.length, c.nom).toBeGreaterThan(0);
      expect(new Set(marques.map((e: Obj) => e.piege)), c.nom).toEqual(new Set([c.nom]));
    }
  });

  it('R5 — la vérité est ce qui est dessiné : chaque libellé, cellule et champ attendu figure dans le HTML du cas', () => {
    for (const c of corpus) {
      const html = text(c.html);
      for (const e of c.inventaire.elements as Obj[]) {
        const dits: string[] = [];
        if (e.type === 'texte') dits.push(e.libelle);
        if (e.type === 'composant' && e.contenu) dits.push(e.contenu);
        if (e.type === 'table') dits.push(...e.colonnes, ...e.lignes.flat());
        if (e.type === 'gabarit') dits.push(...e.champs.map((f: Obj) => f.nom));
        if (e.type === 'statut') dits.push(e.libelle);
        for (const d of dits) expect(html, `${c.nom} : « ${d} »`).toContain(d);
      }
    }
  });

  it('R6 — texte ambigu levé par la figure : un lien precise dont la lecture ambiguë est dans le texte et la raison dans la figure', () => {
    const [lien] = elements('texte-ambigu-leve-par-figure', 'lien');
    expect(lien).toMatchObject({ constat: 'precise', piege: 'texte-ambigu-leve-par-figure' });
    const html = cas('texte-ambigu-leve-par-figure').html;
    expect(text(html)).toContain(lien!.passage.extrait);
    expect(html).toMatch(/<svg/);
  });

  it('R7 — figure qui contredit le texte : un lien contredit à deux énoncés, l’un dit par le texte, l’autre par la figure', () => {
    const [lien] = elements('figure-contredit-texte', 'lien');
    expect(lien).toMatchObject({ constat: 'contredit', piege: 'figure-contredit-texte' });
    expect(lien!.enonces).toHaveLength(2);
    expect(lien!.enonces[0]).not.toBe(lien!.enonces[1]);
  });

  it('R8 — table en image : la table attendue est dessinée dans un élément rastérisé, hors couche texte du PDF', () => {
    const c = cas('table-en-image');
    expect(elements('table-en-image', 'table')).toHaveLength(1);
    expect(c.html).toMatch(/class="[^"]*\braster\b/);
  });

  it('R9 — gabarit de type BUFR : champs ordonnés, obligatoires ou facultatifs, avec bornes', () => {
    const [g] = elements('gabarit-type-bufr', 'gabarit');
    expect(g!.champs.length).toBeGreaterThanOrEqual(4);
    expect(g!.champs.some((f: Obj) => f.obligatoire === true)).toBe(true);
    expect(g!.champs.some((f: Obj) => f.obligatoire === false)).toBe(true);
    expect(g!.champs.some((f: Obj) => typeof f.min === 'number' && typeof f.max === 'number')).toBe(true);
  });

  it('R10 — contrôle translucide : un jeton d’opacité inférieure à 1 et un bouton posé sur un fond chargé', () => {
    const [jeton] = elements('controle-translucide', 'jeton');
    expect(jeton).toMatchObject({ categorie: 'opacite', piege: 'controle-translucide' });
    expect(Number(jeton!.valeur)).toBeLessThan(1);
    const html = cas('controle-translucide').html;
    expect(html).toContain(`rgba(255, 255, 255, ${jeton!.valeur})`);
    expect(html).toMatch(/gradient/);
  });

  it('R11 — page Proposal parmi des pages exigées : le statut est sur la page de la maquette et couvre un composant, les exigences sont sur l’autre', () => {
    const [statut] = elements('page-proposal', 'statut');
    expect(statut).toMatchObject({ libelle: 'Proposal', piege: 'page-proposal' });
    expect(cas('page-proposal').pages).toBe(2);
    expect(statut!.source.page).toBe(2);
    expect(statut!.couvre.length).toBeGreaterThan(0);
    expect(elements('page-proposal', 'texte').some((t) => t.role === 'exigence' && t.source.page === 1)).toBe(true);
  });

  it('R11 — le corpus porte des états (sur des composants du corpus, sur la page de leur composant) et un lien confirme, hors piège', () => {
    const etats = corpus.flatMap((c) => elements(c.nom, 'etat').map((e) => ({ c: c.nom, e })));
    expect(etats.map(({ e }) => e.nom)).toEqual(['selectionne', 'desactive']);
    for (const { c, e } of etats) {
      const cible = cas(c).inventaire.elements.find((x: Obj) => x.id === e.cible)!;
      expect(cible.type).toBe('composant');
      expect(e.source.page).toBe(cible.source.page);
      expect(e.piege).toBeUndefined();
    }
    const confirmes = corpus.flatMap((c) => elements(c.nom, 'lien')).filter((l) => l.constat === 'confirme');
    expect(confirmes).toHaveLength(1);
    expect(text(cas('page-proposal').html)).toContain(confirmes[0]!.figure);
  });

  it('R12 — scan bruité : le cas est marqué rastérisé et tous ses textes attendus sont issus d’un OCR', () => {
    const c = cas('scan-bruite');
    expect(c.scan).toBe(true);
    const textes = elements('scan-bruite', 'texte');
    expect(textes.length).toBeGreaterThan(0);
    expect(textes.every((t) => t.ocr === true)).toBe(true);
    expect(corpus.filter((x) => x.scan).map((x) => x.nom)).toEqual(['scan-bruite']);
  });

  it('R13 — ref corpus --sans-rendu écrit le document HTML et l’attendu de chaque cas, sans PDF ni PNG', async () => {
    const r = await corpusCmd(['--sans-rendu']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readdirSync(r.dir).sort()).toEqual([...PIEGES].sort());
    for (const c of corpus) {
      const dossier = join(r.dir, c.nom);
      expect(JSON.parse(readFileSync(join(dossier, 'attendu.json'), 'utf8'))).toEqual(c.inventaire);
      expect(readFileSync(join(dossier, 'document.html'), 'utf8')).toBe(c.html);
      expect(readdirSync(dossier).filter((f) => /\.(pdf|png)$/.test(f))).toEqual([]);
    }
    expect(r.out).toContain('7 cas');
  });

  it('R14 — sans --sans-rendu et sans Playwright, la commande est refusée (code 2) en nommant CADENCE_PLAYWRIGHT, et n’écrit rien', async () => {
    const r = await corpusCmd([], { CADENCE_PLAYWRIGHT: '/nulle/part/playwright' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/CADENCE_PLAYWRIGHT/);
    expect(existsSync(r.dir)).toBe(false);
  });

  it('R15 — un dossier de corpus déjà écrit est refusé : le corpus n’est jamais mêlé à un autre', async () => {
    const dir = tempDir();
    const io = (out: string[], err: string[]) => ({ cwd: dir, env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date('2026-10-24T10:00:00') });
    const err: string[] = [];
    expect(await run(['ref', 'corpus', join(dir, 'c'), '--sans-rendu'], io([], err))).toBe(0);
    expect(await run(['ref', 'corpus', join(dir, 'c'), '--sans-rendu'], io([], err))).toBe(2);
    expect(err.join('\n')).toMatch(/existe déjà/);
  });

  // Rendu réel : demande Playwright et son Chromium, que le dépôt ne porte pas (CADENCE_PLAYWRIGHT = dossier du paquet playwright).
  it.skipIf(!process.env.CADENCE_PLAYWRIGHT)('R16 — le rendu écrit un PDF et un PNG de 1700×2200 (200 dpi) par page ; le scan et la table en image n’ont pas de couche texte', async () => {
    const r = await corpusCmd([], { ...process.env, PATH: process.env.PATH });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const c of corpus) {
      expect(existsSync(join(r.dir, c.nom, 'document.pdf')), c.nom).toBe(true);
      for (let i = 0; i < c.pages; i++) {
        const png = readFileSync(join(r.dir, c.nom, `page-${i + 1}.png`));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1700, 2200]);
      }
    }
    const couche = (nom: string) => execFileSync('pdftotext', [join(r.dir, nom, 'document.pdf'), '-'], { encoding: 'utf8' });
    expect(couche('scan-bruite').trim()).toBe('');
    expect(couche('table-en-image')).toContain('Cloud amount codes');
    expect(couche('table-en-image')).not.toContain('Overcast');
  }, 120_000);

  it.skipIf(!process.env.CADENCE_PLAYWRIGHT)('R17 — le PDF de chaque cas a autant de pages que l’attendu (le scan ne s’ouvre pas sur une page blanche)', async () => {
    const r = await corpusCmd([], { ...process.env });
    expect(r.code, r.err).toBe(0);
    for (const c of corpus) {
      const info = execFileSync('pdfinfo', [join(r.dir, c.nom, 'document.pdf')], { encoding: 'utf8' });
      expect(info.match(/^Pages:\s+(\d+)/m)?.[1], c.nom).toBe(String(c.pages));
    }
  }, 120_000);

  it.skipIf(!process.env.CADENCE_PLAYWRIGHT)('R18 — après rendu, l’empreinte de l’attendu est celle du document.pdf écrit, celui que ref add enregistre', async () => {
    const r = await corpusCmd([], { ...process.env });
    expect(r.code, r.err).toBe(0);
    for (const c of corpus) {
      const attendu = JSON.parse(readFileSync(join(r.dir, c.nom, 'attendu.json'), 'utf8'));
      expect(attendu.document.sha256, c.nom).toBe(createHash('sha256').update(readFileSync(join(r.dir, c.nom, 'document.pdf'))).digest('hex'));
      expect(attendu.document.slug).toBe(`corpus-${c.nom}`);
      expect(checkInventaire(attendu), c.nom).toEqual([]);
    }
  }, 120_000);

  // Les zones des textes d'une figure sont comptées en pixels de la page rendue : le décalage de la figure sur la page (60 px CSS, 170 px CSS) se perd facilement.
  it.skipIf(!process.env.CADENCE_PLAYWRIGHT)('R20 — la zone attendue de chaque texte contient ce que le rendu dessine (mots et boîtes de pdftotext -bbox)', async () => {
    const r = await corpusCmd([], { ...process.env });
    expect(r.code, r.err).toBe(0);
    const K = 200 / 72;
    let verifies = 0;
    for (const c of corpus) {
      const bbox = execFileSync('pdftotext', ['-bbox', join(r.dir, c.nom, 'document.pdf'), '-'], { encoding: 'utf8' });
      const pages = bbox.split('<page ').slice(1).map((pg) => [...pg.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)].map((m) => ({ b: [1, 2, 3, 4].map((i) => Number(m[i]) * K), mot: m[5]!.replace(/&amp;/g, '&') })));
      for (const e of elements(c.nom, 'texte')) {
        if (e.ocr) continue;
        const mots: string[] = e.libelle.split(' ');
        const page = pages[e.source.page - 1]!;
        const debut = page.findIndex((_, i) => mots.every((m, j) => page[i + j]?.mot === m));
        expect(debut, `${c.nom} : « ${e.libelle} » absent du rendu`).toBeGreaterThanOrEqual(0);
        const dessine = page.slice(debut, debut + mots.length).map((w) => w.b);
        const [x0, y0, x1, y1] = [Math.min(...dessine.map((b) => b[0]!)), Math.min(...dessine.map((b) => b[1]!)), Math.max(...dessine.map((b) => b[2]!)), Math.max(...dessine.map((b) => b[3]!))];
        const z = e.source.zone;
        const dedans = Math.max(0, Math.min(x1, z.x + z.l) - Math.max(x0, z.x)) * Math.max(0, Math.min(y1, z.y + z.h) - Math.max(y0, z.y));
        // 85 % : la boîte de pdftotext suit les métriques de la police (quelques pixels au-dessus de la ligne), pas la boîte du bloc
        expect(dedans / ((x1 - x0) * (y1 - y0)), `${c.nom} : « ${e.libelle} » dessiné en [${[x0, y0, x1, y1].map(Math.round)}], attendu en [${z.x},${z.y},${z.x + z.l},${z.y + z.h}]`).toBeGreaterThanOrEqual(0.85);
        verifies++;
      }
    }
    expect(verifies).toBeGreaterThanOrEqual(20);
  }, 120_000);

  it('R19 — si Chromium ne se lance pas (paquet présent, navigateur absent), la commande est refusée (code 2) avant d’écrire quoi que ce soit', async () => {
    const faux = tempDir();
    writeFileSync(join(faux, 'package.json'), '{"name":"playwright","main":"index.js"}');
    writeFileSync(join(faux, 'index.js'), "exports.chromium = { launch: async () => { throw new Error(\"browserType.launch: Executable doesn't exist\"); } };");
    const r = await corpusCmd([], { CADENCE_PLAYWRIGHT: faux });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Executable doesn't exist/);
    expect(r.err).toMatch(/playwright install chromium/);
    expect(existsSync(r.dir)).toBe(false);
  });
});
