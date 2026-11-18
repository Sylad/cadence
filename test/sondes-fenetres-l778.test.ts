// L778, revue r4 : fermé par défaut. Le relecteur avait ouvert deux popups dans la même tâche et parlé au serveur depuis le second, qui n'avait
// pas le script d'initialisation : « v15 WSSTREAM DELETE item 1 » et « v16 WS DELETE item 1 » reçus, rapport « aucun constat », code 0.
// Les pages sont celles de son essai (hors dépôt : exp4/run5.mjs et pages5.mjs, V=v1..v16), reprises telles quelles, servies par
// test/sondes-serveur-l778.ts qui note tout ce qu'il reçoit. Ce que le test tient : aucun message reçu ET un constat « fenêtre non gardée »,
// code de sortie non nul. La partie navigateur ne joue que si un Playwright est chargeable sur la machine.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeSortie, DEFAUTS, formater, lancerNavigateur, sonder, type Rapport } from '../scripts/sondes-interaction.mjs';
import { serveurSondes } from './sondes-serveur-l778.js';

/** Les variantes de l'essai r4 (pages5.mjs), plus trois voies voisines : document.open à trois arguments, deux popups avec page, popup refermé par l'app. */
const V: Record<string, string> = {
  v1: `const p = window.open('', '_blank'); ecrire(p, 'v1');`,
  v4: `const a = window.open('', '_blank'); const p = window.open('', '_blank'); ecrire(a, 'v4a'); ecrire(p, 'v4b');`,
  v9: `window.open('', '_blank'); const p = window.open('', '_blank'); ecrire(p, 'v9');`,
  v14: `window.open('', '_blank'); const p = window.open('', '_blank'); p.document.write('<script>const s = new WebSocketStream(opener.WSO + "/socket?v14"); s.opened.then(({ writable }) => writable.getWriter().write("v14 WSSTREAM DELETE")); new SharedWorker(opener.location.origin + "/shared.js").port.start();<\\/script>'); p.document.close();`,
  v15: `window.open('', '_blank'); const p = window.open('', '_blank'); const s = new p.WebSocketStream(WSO + '/socket?v15'); s.opened.then(({ writable }) => writable.getWriter().write('v15 WSSTREAM DELETE item 1'));`,
  v16: `window.open('', '_blank'); const p = window.open('', '_blank'); const w = new p.WebSocket(WSO + '/socket?v16'); w.onopen = () => w.send('v16 WS DELETE item 1');`,
  docopen: `window.open('', '_blank'); const p = document.open('', '_blank', 'popup'); ecrire(p, 'docopen');`,
  avecpage: `window.open('/vide.html', '_blank'); const p = window.open('/vide.html', '_blank'); ecrire(p, 'avecpage');`,
  iframe: `window.open('', '_blank'); const f = document.createElement('iframe'); document.body.appendChild(f); const p = f.contentWindow.open('', '_blank'); ecrire(p, 'iframe');`,
};

const pages = (v: string) => ({
  '/p.html': `<!doctype html><html><head><meta charset="utf-8"><title>essai r4 popup</title></head><body>
<ul><li>A <button id="b1">x</button></li><li>B <button id="b2">y</button></li></ul>
<script>
const WSO = location.origin.replace('http', 'ws');
function ecrire(win, nom, partage) {
  if (!win) return fetch('/report?' + nom + '.fenetre=null');
  const ws = new win.WebSocket(WSO + '/socket?' + nom); ws.onopen = () => ws.send(nom + ' WS DELETE');
  if (win.WebSocketStream) { const s = new win.WebSocketStream(WSO + '/socket?stream' + nom); s.opened.then(({ writable }) => writable.getWriter().write(nom + ' WSSTREAM DELETE')); }
  if (partage && win.SharedWorker) new win.SharedWorker('/shared.js').port.start();
  fetch('/report?' + nom + '.wss=' + typeof win.WebSocketStream + '&beacon=' + win.navigator.sendBeacon('/beacon-' + nom, 'x'));
}
document.getElementById('b1').addEventListener('click', () => { ${V[v]} });
</script></body></html>`,
  '/vide.html': '<!doctype html><title>v</title>',
  '/shared.js': `const ws = new WebSocket(location.origin.replace('http', 'ws') + '/socket?shared'); ws.onopen = () => ws.send('SHARED DELETE');`,
});

const lance = await lancerNavigateur(process.env, process.cwd());
afterAll(async () => { await lance?.fermer(); });

const BASE: Rapport = { url: 'u', largeur: 390, hauteur: 844, seuil: 1, date: 'd', repos: [], ecrituresBloquees: 0, parcours: [],
  controles: [{ id: '1', nom: 'x', role: 'bouton', liste: true, mesure: { sautMax: 0, sautFinal: 0, defilement: [], regions: null }, constats: [] }] };

describe('L778 revue r4 — une fenêtre non gardée est un constat, code non nul (sans navigateur)', () => {
  it('le rapport dit « fenêtre non gardée », jamais « aucun constat » seul, et le code est 2', () => {
    expect(codeSortie(BASE)).toBe(0);
    const r: Rapport = { ...BASE, fenetres: ['http://h/p.html a ouvert une fenêtre (about:blank) sans marqueur ; fermée avant tout usage, window.open a rendu null'] };
    expect(codeSortie(r)).toBe(2);
    const t = formater(r);
    expect(t).toContain('  ✗ fenêtre non gardée : http://h/p.html a ouvert une fenêtre (about:blank)');
    expect(t).toMatch(/^passe non vérifiée : 1 fenêtre\(s\) ou cible\(s\) non gardée\(s\)/m);
    expect(t).not.toMatch(/^aucun constat/m);
  });

  it('une cible non gardée (worker) le dit aussi sur la ligne de bilan', () => {
    expect(formater({ ...BASE, nonGardes: ['shared_worker http://h/s.js : démarré'] })).toMatch(/^passe non vérifiée : 1 fenêtre\(s\) ou cible\(s\) non gardée\(s\)/m);
  });

  it('la ligne « lecture seule » dit la règle des fenêtres et que la raison d\'une fermeture WebSocket n\'est pas coupée', () => {
    const t = formater(BASE);
    expect(t).toContain('fermée avant tout usage');
    expect(t).toMatch(/non couvert : .*la raison d'une fermeture WebSocket/);
  });

  it('la doc et le changelog ne disent plus « every popup » : fermé par défaut, constat sinon ; la raison de close() est sous « Not covered »', () => {
    const lire = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8').replace(/\s+/g, ' ');
    for (const f of ['docs/sondes-interaction.md', 'changelog.d/L778.md']) {
      const t = lire(f);
      expect(t, f).not.toMatch(/every (iframe and every )?popup|every iframe and popup/i);
      expect(t, f).toContain('fenêtre non gardée');
      expect(t, f).toMatch(/closed by default/i);
      expect(t, f).toMatch(/not covered:?\*{0,2} [^.]*close reason/i);
    }
  });
});

describe.skipIf(!lance)('L778 revue r4 — l\'essai du relecteur rejoué (exp4/run5.mjs) : second popup de la même tâche (navigateur réel)', () => {
  const dossier = join(import.meta.dirname, 'fixtures', 'sondes');
  const ESSAI = { ...DEFAUTS, charge: 1500, repos: 500, attente: 800 };
  const ecrits = (http: string[]) => http.filter((l) => !/^(GET|HEAD|OPTIONS) /.test(l));
  const jouer = async (v: string) => {
    const srv = await serveurSondes(dossier, pages(v));
    try {
      const r = await sonder(lance!.navigateur, `${srv.url}/p.html`, ESSAI, []);
      await new Promise((ok) => setTimeout(ok, 300));
      return { r, recu: srv.recu, texte: formater(r) };
    } finally {
      await srv.fermer();
    }
  };

  const vues: number[] = [];
  // Chaque variante deux fois, comme le relecteur : le défaut était déterministe.
  for (const v of ['v15', 'v16', 'v4', 'v9', 'v14', 'docopen', 'avecpage', 'iframe']) {
    for (const passe of [1, 2]) {
      it(`${v} (passe ${passe}) : le serveur ne reçoit aucun message, « fenêtre non gardée » et code 2, jamais code 0`, async () => {
        const { r, recu, texte } = await jouer(v);
        expect(recu.websocket).toEqual([]); // r4 : « v15 WSSTREAM DELETE item 1 », « v16 WS DELETE item 1 »
        expect(ecrits(recu.http)).toEqual([]);
        expect(recu.http.filter((l) => l.includes('/shared.js'))).toEqual([]);
        expect(codeSortie(r)).not.toBe(0);
        expect(texte).not.toMatch(/^aucun constat$/m);
        // Mesuré ici : le second popup n'a jamais le script au retour de window.open, il est fermé et dit. S'il l'avait à temps (l'ordre d'attache
        // du navigateur n'est pas garanti), il serait gardé comme le premier : écriture coupée ou fonction retirée, code 3, toujours non nul.
        if (r.fenetres!.length) {
          expect(texte).toContain('✗ fenêtre non gardée');
          expect(texte).toMatch(/^passe non vérifiée : /m);
          expect(codeSortie(r)).toBe(2);
        }
        vues.push(r.fenetres!.length);
      });
    }
  }

  it('la fermeture par défaut a bien joué : au moins une passe a fermé et dit une fenêtre non gardée', () => {
    expect(vues.filter((n) => n > 0).length).toBeGreaterThan(0);
  });

  it('v1 : un seul popup, gardé avant le retour de window.open : rien reçu, aucune fenêtre non gardée', async () => {
    const { r, recu } = await jouer('v1');
    expect(recu.websocket).toEqual([]);
    expect(ecrits(recu.http)).toEqual([]);
    expect(recu.http.filter((l) => l.includes('/report?'))).toEqual(['GET /report?v1.wss=undefined&beacon=false']);
    expect(r.fenetres).toEqual([]);
    expect(r.nonGardes).toEqual([]);
  });
});
