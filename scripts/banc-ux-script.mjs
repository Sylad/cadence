#!/usr/bin/env node
// Banc réduit du mode script du ux-reviewer (L839, D-34) : sans modèle, ce que chaque mode fait entrer dans le contexte de l'agent pour UNE page.
//   node scripts/banc-ux-script.mjs <url> [--largeurs 375,768,1024,1440] [--hauteur 900] [--captures-lues 2]
// Mode actuel, au minimum : à chaque largeur, un instantané d'accessibilité (ce que rend browser_snapshot, ici `ariaSnapshot()` de Playwright)
// et une capture de la vue regardée. Mode script : le compte rendu de `cadence mesures` et les captures regardées (2 par défaut : 375 et 1440).
// Les jetons d'un texte sont estimés à 1 pour 4 caractères ; ceux d'une image par la règle de l'API (largeur × hauteur / 750, image ramenée
// à 1568 px au plus grand côté et 1,15 Mpx). C'est un plancher du mode actuel (un seul instantané par largeur, aucun clic) : le vrai banc est
// la revue rejouée, docs/mesures/ux-mode-script-l839.md.
import { fileURLToPath } from 'node:url';
import { lancerNavigateur } from './sondes-interaction.mjs';
import { DEFAUTS, formater, lireOptions, mesurer } from './mesures-page.mjs';

/** Jetons d'une image envoyée au modèle (règle publiée de l'API : côté long ≤ 1568 px, ≤ 1,15 Mpx, puis l × h / 750). */
export function jetonsImage(largeur, hauteur) {
  const k = Math.min(1, 1568 / Math.max(largeur, hauteur), Math.sqrt(1_150_000 / (largeur * hauteur)));
  return Math.ceil((Math.floor(largeur * k) * Math.floor(hauteur * k)) / 750);
}

export const jetonsTexte = (texte) => Math.ceil(texte.length / 4);

/** Le mode actuel au minimum : un instantané et une capture de la vue par largeur. */
async function modeActuel(navigateur, o) {
  let jetons = 0;
  for (const largeur of o.largeurs) {
    const contexte = await navigateur.newContext({ viewport: { width: largeur, height: o.hauteur } });
    try {
      const page = await contexte.newPage();
      await page.goto(o.url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(o.charge);
      jetons += jetonsTexte(await page.locator('body').ariaSnapshot()) + jetonsImage(largeur, o.hauteur);
    } finally {
      await contexte.close();
    }
  }
  return jetons;
}

/** Les deux bras sur une page : jetons estimés de chacun et compte rendu du mode script. */
export async function banc(navigateur, o, capturesLues = 2) {
  const actuel = await modeActuel(navigateur, o);
  const texte = formater(await mesurer(navigateur, o), o.max);
  const images = [...o.largeurs].sort((a, b) => a - b).filter((l, i, t) => i === 0 || i === t.length - 1).slice(0, capturesLues);
  const script = jetonsTexte(texte) + images.reduce((n, l) => n + jetonsImage(l, o.hauteur), 0);
  return { actuel, script, texte };
}

async function main(argv) {
  const i = argv.indexOf('--captures-lues');
  const lues = i >= 0 ? Number(argv.splice(i, 2)[1]) : 2;
  const o = lireOptions(argv);
  const lance = await lancerNavigateur(process.env, process.cwd());
  if (!lance) { console.error('banc : aucun navigateur lançable : non vérifié'); return 2; }
  try {
    const r = await banc(lance.navigateur, { ...o, rendu: lance.rendu }, lues);
    console.log(r.texte);
    console.log(`\nbanc réduit — ${o.url} — largeurs ${o.largeurs.join(', ')} (défaut ${DEFAUTS.largeurs.join(', ')})`);
    console.log(`mode actuel (plancher : 1 instantané + 1 capture par largeur) : ~${r.actuel} jetons`);
    console.log(`mode script (compte rendu + ${lues} capture(s) regardée(s)) : ~${r.script} jetons (${Math.round((100 * r.script) / r.actuel)} % du mode actuel)`);
    return 0;
  } finally {
    await lance.fermer();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
