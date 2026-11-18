// L778 revue r2 : un worker (dédié, partagé ou module) qui tient la socket de l'app et écrit sur demande de la page : fetch POST et ws.send.
const p = new URLSearchParams(location.search);
const nom = p.get('nom');
const ws = new WebSocket(location.origin.replace('http', 'ws') + '/socket');
function ecrire() {
  fetch('/' + nom.toLowerCase() + '-post', { method: 'POST', body: 'x' }).catch(() => {});
  if (ws.readyState === 1) ws.send(nom + ' DELETE'); else ws.addEventListener('open', () => ws.send(nom + ' DELETE'));
}
if (p.get('partage')) onconnect = (e) => { const port = e.ports[0]; port.onmessage = ecrire; port.start(); };
else onmessage = ecrire;
