import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { RafError } from '../plan.js';
import type { CasCorpus } from './corpus.js';

/** 816×1056 px CSS = 8,5×11 in ; à 200 dpi, 1700×2200 px : le repère des zones de l'inventaire. */
const ECHELLE = 200 / 96;

const BRUIT = `<svg style="position:absolute" width="0" height="0"><filter id="bruit" x="0" y="0" width="100%" height="100%">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="t"/>
<feColorMatrix in="t" type="matrix" values="0 0 0 0 .25  0 0 0 0 .25  0 0 0 0 .25  1.2 0 0 0 -.38" result="grain"/>
<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="grain"/></feMerge></filter></svg>`;

export interface Navigateur {
  newContext(o: object): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}
interface Page {
  setContent(html: string): Promise<void>;
  locator(s: string): { count(): Promise<number>; nth(i: number): Element; all(): Promise<Element[]> };
  evaluate<T>(fn: (...a: any[]) => T, ...a: unknown[]): Promise<T>;
  pdf(o: object): Promise<Buffer>;
}
interface Element {
  screenshot(o?: object): Promise<Buffer>;
  evaluate<T>(fn: (...a: any[]) => T, ...a: unknown[]): Promise<T>;
}

/** Playwright, d'où `CADENCE_PLAYWRIGHT` (dossier du paquet) le désigne, sinon depuis le dossier courant : le dépôt n'en dépend pas. */
export function chargerPlaywright(env: NodeJS.ProcessEnv, cwd: string): { chromium: { launch(o?: object): Promise<Navigateur> } } {
  const aide = 'installez-le (npm i -D playwright, puis npx playwright install chromium) ou pointez CADENCE_PLAYWRIGHT vers le dossier du paquet playwright, ou ajoutez --sans-rendu';
  const cible = env.CADENCE_PLAYWRIGHT;
  try {
    return createRequire(join(cwd, 'noop.js'))(cible ?? 'playwright');
  } catch {
    throw new RafError(cible ? `ref corpus : CADENCE_PLAYWRIGHT (${cible}) ne désigne pas un paquet playwright lisible : ${aide}` : `ref corpus : Playwright est introuvable : ${aide}`);
  }
}

export type Playwright = ReturnType<typeof chargerPlaywright>;

/** Lance Chromium : un navigateur absent ou d'une autre version est un refus, avant que le moindre fichier soit écrit. */
export async function lancer(playwright: Playwright): Promise<Navigateur> {
  try {
    return await playwright.chromium.launch();
  } catch (e) {
    throw new RafError(`ref corpus : Chromium ne se lance pas (${(e as Error).message.split('\n')[0]}) : installez-le avec npx playwright install chromium, ou ajoutez --sans-rendu`);
  }
}

/** Rend chaque cas dans `<dossier>/<nom>/` (le HTML et l'attendu y sont déjà), puis ferme le navigateur. */
export async function rendre(navigateur: Navigateur, dossier: string, cas: CasCorpus[]): Promise<void> {
  try {
    for (const c of cas) await rendreCas(navigateur, join(dossier, c.nom), c);
  } finally {
    await navigateur.close();
  }
}

/** Écrit `document.pdf` et `page-<n>.png` (1700×2200) d'un cas : tables en image rastérisées, scan rastérisé puis bruité. */
async function rendreCas(navigateur: Navigateur, dossier: string, cas: CasCorpus): Promise<void> {
  const contexte = await navigateur.newContext({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: ECHELLE });
  try {
    const page = await contexte.newPage();
    await page.setContent(cas.html);
    for (const el of await page.locator('.raster').all()) {
      const src = `data:image/png;base64,${(await el.screenshot()).toString('base64')}`;
      await el.evaluate((n: HTMLElement, s: string) => {
        const r = n.getBoundingClientRect();
        n.outerHTML = `<img src="${s}" style="display:block;width:${r.width}px;height:${r.height}px">`;
      }, src);
    }
    if (cas.scan) {
      await page.evaluate((bruit: string) => {
        document.body.insertAdjacentHTML('afterbegin', bruit);
        document.querySelectorAll<HTMLElement>('.page').forEach((p) => {
          p.innerHTML = `<div style="position:relative;width:816px;height:1056px;transform:rotate(0.6deg)">${p.innerHTML}</div>`;
          p.style.filter = 'url(#bruit) grayscale(1) blur(0.6px) contrast(1.15)';
        });
      }, BRUIT);
    }
    const sections = page.locator('.page');
    const prises: Buffer[] = [];
    for (let i = 0; i < cas.pages; i++) prises.push(await sections.nth(i).screenshot());
    if (cas.scan) {
      // le PDF d'un scan ne porte que l'image de chaque page, jamais la couche texte
      await page.evaluate((images: string[]) => {
        document.querySelectorAll<HTMLElement>('.page').forEach((p, i) => {
          p.style.cssText = '';
          p.innerHTML = `<img src="${images[i]}" style="display:block;width:816px;height:1056px">`;
        });
      }, prises.map((b) => `data:image/png;base64,${b.toString('base64')}`));
    }
    mkdirSync(dossier, { recursive: true });
    prises.forEach((b, i) => writeFileSync(join(dossier, `page-${i + 1}.png`), b));
    writeFileSync(join(dossier, 'document.pdf'), await page.pdf({ width: '8.5in', height: '11in', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }));
  } finally {
    await contexte.close();
  }
}
