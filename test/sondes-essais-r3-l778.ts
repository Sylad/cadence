// L778, revue r3 : les pages des deux essais du relecteur (hors dépôt : exp3/run2.mjs « minimal » et exp3/run.mjs « large »), reprises telles
// quelles pour en faire des tests du dépôt. Servies par test/sondes-serveur-l778.ts, qui note tout ce qu'il reçoit.
// Ce que r3 avait reçu : « SHARED DELETE NATIF » et « PAGE STREAM DELETE » (minimal, 4 passes sur 4), 31 messages WebSocket (large) venus d'un
// SharedWorker et de WebSocketStream dans la page et ses iframes.
type Pages = Record<string, string | ((requete: string) => string)>;

/** L'essai minimal : un SharedWorker qui tient la socket de l'app et garde `send`, un WebSocketStream de la page, un service worker. */
export const essaiMinimal = (): Pages => ({
  '/p.html': `<!doctype html><html><head><meta charset="utf-8"><title>essai r3 simple</title></head><body>
<ul><li>A <button id="b1">x</button></li><li>B <button id="b2">y</button></li></ul>
<script>
const s = new SharedWorker('/shared.js'); s.port.start();
document.getElementById('b1').addEventListener('click', () => s.port.postMessage('go'));
document.getElementById('b2').addEventListener('click', () => { const w = new WebSocketStream(location.origin.replace('http', 'ws') + '/socket?page'); w.opened.then(({ writable }) => writable.getWriter().write('PAGE STREAM DELETE')); });
navigator.serviceWorker.register('/sw.js').then(() => fetch('/report?sw=ENREGISTRE'), () => fetch('/report?sw=refuse'));
</script></body></html>`,
  '/shared.js': `// un SharedWorker qui tient la socket de l'app : il s'annonce à l'ouverture (cas courant : abonnement, présence), garde send, écrit sur demande
const envoyer = WebSocket.prototype.send;
const ws = new WebSocket(location.origin.replace('http', 'ws') + '/socket?shared');
ws.onopen = () => ws.send('SHARED HELLO');
onconnect = (e) => { const p = e.ports[0]; p.onmessage = () => { ws.send('SHARED DELETE'); envoyer.call(ws, 'SHARED DELETE NATIF'); }; p.start(); };`,
  '/sw.js': SW,
});

/**
 * La même page qu'une app qui teste la présence de chaque fonction avant de s'en servir : rien ne lève, les boutons vivent, et chaque voie
 * retirée est demandée au clic (l'essai minimal, lui, s'arrête à sa première ligne : `new SharedWorker` y lève).
 */
export const essaiPrudent = (): Pages => ({
  ...essaiMinimal(),
  '/p.html': `<!doctype html><html><head><meta charset="utf-8"><title>essai r3 prudent</title></head><body>
<ul><li>A <button id="b1">x</button></li><li>B <button id="b2">y</button></li><li>C <button id="b3">z</button></li></ul>
<script>
const rep = (k, v) => fetch('/report?' + k + '=' + v).catch(() => {});
const s = window.SharedWorker ? new SharedWorker('/shared.js') : null; if (s) s.port.start();
rep('shared', s ? 'CONSTRUIT' : 'absent');
document.getElementById('b1').addEventListener('click', () => { rep('clic-shared', typeof SharedWorker); if (s) s.port.postMessage('go'); });
document.getElementById('b2').addEventListener('click', () => {
  if (!window.WebSocketStream) return rep('wsstream', 'absent');
  const w = new WebSocketStream(location.origin.replace('http', 'ws') + '/socket?page'); w.opened.then(({ writable }) => writable.getWriter().write('PAGE STREAM DELETE'));
});
document.getElementById('b3').addEventListener('click', () => {
  // une fenêtre neuve, lue dans la même tâche que son ouverture : ses constructeurs doivent être retirés eux aussi
  const f = document.createElement('iframe'); document.body.appendChild(f);
  for (const [nom, w] of [['iframe', f.contentWindow], ['popup', window.open('about:blank')]]) {
    for (const k of ['SharedWorker', 'WebSocketStream', 'WebTransport']) {
      let etat = 'absent';
      try { if (w && w[k]) { etat = 'PRESENT'; if (k === 'SharedWorker') { new w[k]('/shared.js').port.start(); } if (k === 'WebSocketStream') { new w[k](location.origin.replace('http', 'ws') + '/socket?' + nom).opened.then(({ writable }) => writable.getWriter().write(nom + ' STREAM DELETE')); } } } catch (e) { etat = 'leve'; }
      rep(nom + '.' + k, w ? etat : 'bloque');
    }
  }
});
navigator.serviceWorker.register('/sw.js').then(() => rep('sw', 'ENREGISTRE'), () => rep('sw', 'refuse'));
</script></body></html>`,
});

const SW = `fetch('/sw-post', { method: 'POST', body: 'x' }).catch(() => {}); const ws = new WebSocket(location.origin.replace('http','ws') + '/socket?sw'); ws.onopen = () => ws.send('SW WS');`;

/** Le script de tout worker de l'essai large : il écrit par chaque voie à sa première ligne, à chaque message et à chaque connexion. */
const W = (nom: string) => `
const O = location.origin.startsWith('http') ? location.origin : self.__o;
const nom = ${JSON.stringify(nom)};
const envoyerNatif = WebSocket.prototype.send;
const rep = (k, v) => fetch(O + '/report?' + nom + '.' + k + '=' + encodeURIComponent(v)).catch(() => {});
function ecrire(quand) {
  fetch(O + '/' + nom + '-post-' + quand, { method: 'POST', body: 'x' }).then(() => rep('post-' + quand, 'PASSE'), () => {});
  fetch(O + '/' + nom + '-delete-' + quand, { method: 'DELETE', keepalive: true }).catch(() => {});
  try { const x = new XMLHttpRequest(); x.open('PUT', O + '/' + nom + '-xhr-' + quand); x.send('x'); } catch (e) {}
  const ws = new WebSocket(O.replace('http', 'ws') + '/socket?' + nom);
  ws.onopen = () => { try { ws.send(nom + ' WS ' + quand); } catch (e) {} try { envoyerNatif.call(ws, nom + ' WSNATIF ' + quand); } catch (e) {} };
  try { if (self.WebSocketStream) { const s = new WebSocketStream(O.replace('http', 'ws') + '/socket?stream' + nom); s.opened.then(({ writable }) => writable.getWriter().write(nom + ' WSSTREAM ' + quand)).catch(() => {}); rep('wsstream-' + quand, 'CONSTRUIT'); } else rep('wsstream-' + quand, 'absent'); } catch (e) { rep('wsstream-' + quand, 'leve'); }
  try { if (self.WebTransport) { new WebTransport('https://127.0.0.1:1/wt'); rep('wt-' + quand, 'CONSTRUIT'); } else rep('wt-' + quand, 'absent'); } catch (e) { rep('wt-' + quand, 'leve'); }
}
ecrire('debut');
self.onmessage = () => ecrire('message');
self.onconnect = (e) => { const p = e.ports[0]; p.onmessage = () => ecrire('message'); p.start(); ecrire('connect'); };
`;

/**
 * L'essai large : page, iframe about:blank, iframe src, iframe srcdoc, iframe enfant, popup, Worker classique, module, blob, imbriqué, rafale de
 * Workers qui écrivent dès leur première ligne, SharedWorker, service worker, `<a ping>`, formulaire POST ×2, rapport CSP (en-tête servi par le test).
 */
export const essaiLarge = (): Pages => ({
  '/p.html': `<!doctype html><html><head><meta charset="utf-8"><title>essai r3</title></head><body>
<ul><li>A <button id="b1">x</button></li><li>B <button id="b2">y</button></li></ul>
<form id="f" method="post" action="/form-post"><input name="a" value="1"></form>
<a id="lien" href="#x" ping="/a-ping">.</a>
<script>
const O = location.origin, rep = (k, v) => fetch('/report?' + k + '=' + encodeURIComponent(v)).catch(() => {});
function ecrireDepuis(win, nom) {
  try { win.fetch(O + '/' + nom + '-post', { method: 'POST', body: 'x' }).then(() => rep(nom + '.post', 'PASSE'), () => {}); } catch (e) {}
  try { win.fetch(O + '/' + nom + '-patch', { method: 'PATCH', keepalive: true, body: 'x' }).catch(() => {}); } catch (e) {}
  try { const x = new win.XMLHttpRequest(); x.open('DELETE', O + '/' + nom + '-xhr'); x.send(); } catch (e) {}
  try { rep(nom + '.beacon', win.navigator.sendBeacon(O + '/' + nom + '-beacon', 'x')); } catch (e) {}
  try { const ws = new win.WebSocket(O.replace('http', 'ws') + '/socket?' + nom); ws.onopen = () => { ws.send(nom + ' WS'); try { win.WebSocket.prototype.send.call(ws, nom + ' WSPROTO'); } catch (e) {} }; } catch (e) {}
  try { if (win.WebSocketStream) { const s = new win.WebSocketStream(O.replace('http', 'ws') + '/socket?stream' + nom); s.opened.then(({ writable }) => writable.getWriter().write(nom + ' WSSTREAM')).catch(() => {}); rep(nom + '.wsstream', 'CONSTRUIT'); } else rep(nom + '.wsstream', 'absent'); } catch (e) { rep(nom + '.wsstream', 'leve'); }
  try { if (win.WebTransport) { new win.WebTransport('https://127.0.0.1:1/wt'); rep(nom + '.wt', 'CONSTRUIT'); } else rep(nom + '.wt', 'absent'); } catch (e) { rep(nom + '.wt', 'leve'); }
}
const tous = [];
function lancer(quand) {
  ecrireDepuis(window, 'page-' + quand);
  const f = document.createElement('iframe'); document.body.appendChild(f); ecrireDepuis(f.contentWindow, 'iframeblanc-' + quand);
  const g = document.createElement('iframe'); g.src = '/vide.html'; g.onload = () => ecrireDepuis(g.contentWindow, 'iframesrc-' + quand); document.body.appendChild(g);
  const h = document.createElement('iframe'); h.srcdoc = '<script>parent.ecrireDepuis(window, "iframesrcdoc-' + quand + '")<\\/script>'; document.body.appendChild(h);
  const k = document.createElement('iframe'); k.src = '/enfant.html?' + quand; document.body.appendChild(k);
  try { tous.push(new Worker('/w.js?dedie-' + quand)); } catch (e) {}
  try { tous.push(new Worker('/w.js?module-' + quand, { type: 'module' })); } catch (e) {}
  try { tous.push(new Worker(URL.createObjectURL(new Blob(['self.__o=' + JSON.stringify(O) + ';importScripts(' + JSON.stringify(O + '/w.js?blob-' + quand) + ')'], { type: 'text/javascript' })))); } catch (e) {}
  try { tous.push(new Worker('/parent.js?' + quand)); } catch (e) {}
  try { const s = new SharedWorker('/w.js?partage-' + quand); s.port.start(); tous.push(s.port); } catch (e) { rep('partage', 'refuse') }
  try { const s = new SharedWorker('/parent.js?p' + quand); s.port.start(); } catch (e) {}
  for (let i = 0; i < 12; i++) try { new Worker('/w.js?rafale' + i + '-' + quand); } catch (e) {}
  try { navigator.serviceWorker.register('/sw.js').then(() => rep('sw', 'ENREGISTRE'), () => rep('sw', 'refuse')); } catch (e) { rep('sw', 'leve'); }
  document.getElementById('lien').click();
}
lancer('charge');
document.getElementById('b1').addEventListener('click', () => { lancer('clic'); for (const w of tous) w.postMessage('go'); const p = window.open('/enfant.html?popup', '_blank'); rep('popup', p ? 'ouvert' : 'bloque'); });
document.getElementById('b2').addEventListener('click', () => { const f = document.getElementById('f'); f.target = '_blank'; f.submit(); f.target = ''; f.submit(); });
</script><img src="/vide.html"></body></html>`,
  '/vide.html': '<!doctype html><title>v</title>',
  '/enfant.html': `<!doctype html><title>e</title><script>
const nom = 'enfant-' + location.search.slice(1), O = location.origin;
fetch('/' + nom + '-post', { method: 'POST', body: 'x' }).catch(() => {});
navigator.sendBeacon('/' + nom + '-beacon', 'x');
const ws = new WebSocket(O.replace('http', 'ws') + '/socket?' + nom); ws.onopen = () => ws.send(nom + ' WS');
new Worker('/w.js?de-' + nom); try { new SharedWorker('/w.js?partagede-' + nom).port.start(); } catch (e) {}
try { navigator.serviceWorker.register('/sw.js'); } catch (e) {}
</script>`,
  '/parent.js': `new Worker('/w.js?petit-fils-' + location.search.slice(1));`,
  '/sw.js': SW,
  '/w.js': (q) => W(q),
});

/** L'en-tête de l'essai large : un rapport CSP (un POST que le navigateur envoie seul) pour l'image de la page. */
export const ENTETES_LARGE = { '/p.html': { 'content-security-policy-report-only': "img-src 'none'; report-uri /csp-report" } };
