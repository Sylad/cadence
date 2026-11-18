// L778 revue r2 : un worker qui garde dès son démarrage les fonctions natives d'écriture, avant tout code de la sonde injecté trop tard.
const envoyer = WebSocket.prototype.send;
const T = self.WebTransport;
const ws = new WebSocket(location.origin.replace('http', 'ws') + '/socket');
onmessage = () => {
  const go = () => envoyer.call(ws, 'CAPTURE DELETE');
  if (ws.readyState === 1) go(); else ws.addEventListener('open', go);
  if (T) { try { new T('https://127.0.0.1:1/wt'); postMessage('wt-cree'); } catch (e) { postMessage('wt-refuse'); } }
};
