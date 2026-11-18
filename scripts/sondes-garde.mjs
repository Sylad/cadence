// Lecture seule des sondes au niveau du navigateur (L778, revue r2) : la seconde revue a vu un Worker dédié et un SharedWorker écrire sur le serveur
// (POST /shared-post, « WORKER DELETE » et « SHARED DELETE » par WebSocket) alors que le routage Playwright du contexte ne voit ni les requêtes d'un
// SharedWorker ni les WebSocket d'un worker, et que ses scripts d'initialisation ne s'exécutent pas dans les workers.
// La garde parle au navigateur par le protocole DevTools (CDP), à côté de Playwright, sur le port de débogage que Chromium ouvre sur 127.0.0.1 :
// - HTTP : `Fetch` est activé au niveau du NAVIGATEUR, donc pour toute requête de toute cible (page, iframe, popup, Worker, SharedWorker, service
//   worker) ; hors GET, HEAD, OPTIONS elle est refusée avant de partir (une navigation de formulaire reçoit un 204 vide : la page reste) ;
// - workers : chaque cible est attachée EN PAUSE à son démarrage (`waitForDebuggerOnStart`, récursif : workers d'une page, d'un iframe, d'un worker) ;
//   le prélude y est joué tout de suite, puis rejoué juste avant la première ligne de son script (arrêt « beforeScriptExecution ») : `send` des
//   WebSocket ne transmet plus rien, `WebTransport` et `WebSocketStream` lèvent ; puis le worker repart.
// Chaque tentative est notée { voie, cible, detail } dans le puits de la passe en cours. Une cible qu'on n'a pas pu garder est notée dans `echecs` :
// la passe est alors « non vérifiée » (scripts/sondes-interaction.mjs). Le même module coupe les WebSocket de la page (couperLesEcritures) et écrit
// la ligne « lecture seule » du rapport (lectureSeule). Méthode et limites : docs/sondes-interaction.md (Read only).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPT_LECTURE_SEULE } from './sondes-page.mjs';

/** L'argument de lancement de Chromium qui ouvre le port de débogage (port choisi par le système, écrit dans DevToolsActivePort du profil). */
export const ARG_DEBOGAGE = '--remote-debugging-port=0';

const METHODES_LUES = ['GET', 'HEAD', 'OPTIONS'];
const TYPES_WORKER = ['worker', 'shared_worker', 'service_worker'];
const TYPES_DOCUMENT = ['page', 'iframe'];
const LIAISON = '__sondesEcritureWorker';

/**
 * Le prélude joué dans chaque worker avant son code : messages WebSocket, WebTransport et WebSocketStream coupés, chaque tentative notée par la
 * liaison CDP. HTTP n'y est pas touché : il est coupé au réseau du navigateur (Fetch).
 */
export const PRELUDE_WORKER = `(() => {
const lier = self[${JSON.stringify(LIAISON)}];
const noter = (voie, cible, detail) => { try { lier && lier(JSON.stringify({ voie, cible: String(cible), detail: String(detail).slice(0, 80) })); } catch (e) { /* rien */ } };
if (self.WebSocket) {
  const envoyer = function send(d) { noter('websocket', this && this.url, typeof d === 'string' ? d : '[binaire]'); };
  Object.defineProperty(WebSocket.prototype, 'send', { configurable: true, writable: true, value: envoyer });
}
for (const nom of ['WebTransport', 'WebSocketStream']) {
  if (!(nom in self)) continue;
  const bloque = function () { noter(nom, arguments[0] || '', 'bloqué'); throw new DOMException(nom + ' bloqué : sondes en lecture seule', 'SecurityError'); };
  Object.defineProperty(self, nom, { configurable: true, writable: true, value: bloque });
}
})();`;

const GARDES = new WeakMap();

/** La garde armée sur ce navigateur, ou undefined. */
export function gardeDe(navigateur) {
  return GARDES.get(navigateur);
}

/** L'adresse WebSocket du navigateur, lue dans le DevToolsActivePort du profil le plus récent de `dossier` (dossier temporaire du lancement). */
async function adresseDebogage(dossier, delai = 5000) {
  for (let t = 0; t < delai; t += 50) {
    const profils = readdirSync(dossier).map((d) => join(dossier, d, 'DevToolsActivePort')).filter((f) => existsSync(f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const [port, chemin] = profils.length ? readFileSync(profils[0], 'utf8').split('\n') : [];
    if (port && chemin) return `ws://127.0.0.1:${port}${chemin}`;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error('port de débogage du navigateur introuvable (DevToolsActivePort)');
}

/** Une connexion CDP au navigateur (sessions aplaties) : `envoyer` rend la réponse ou lève ; `surEvenement` reçoit chaque événement. */
async function connecter(adresse, surEvenement) {
  const ws = new WebSocket(adresse);
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('connexion au port de débogage du navigateur refusée')); });
  let n = 0;
  const attentes = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (!m.id) return surEvenement(m);
    const a = attentes.get(m.id);
    attentes.delete(m.id);
    if (m.error) a?.ko(new Error(`${a.method} : ${m.error.message}`)); else a?.ok(m.result ?? {});
  };
  ws.onclose = () => { for (const a of attentes.values()) a.ko(new Error('connexion au navigateur fermée')); attentes.clear(); };
  const envoyer = (method, params = {}, sessionId) => new Promise((ok, ko) => {
    n += 1;
    attentes.set(n, { ok, ko, method });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { envoyer, fermer: () => ws.close() };
}

const rien = () => {};
const raisonDe = (e) => String(e?.message ?? e).split('\n')[0];
/** Une cible fermée pendant qu'on la gardait n'a rien pu faire (elle était en pause) : ce n'est pas un échec de la garde. */
const cibleFermee = (raison) => /session|closed|detached|connexion au navigateur fermée/i.test(raison);

/** La garde d'un navigateur : HTTP au réseau, workers en pause à leur démarrage, notes de la passe en cours. */
class Garde {
  constructor() {
    this.passe = null;
    this.echecs = [];
    this.workers = [];
    this.avantScript = new Map();
    this.cdp = null;
  }

  envoyer(method, params, sessionId) {
    return this.cdp.envoyer(method, params, sessionId);
  }

  noter(e) {
    this.passe?.push(e);
  }

  echec(quoi, e) {
    const raison = raisonDe(e);
    if (!cibleFermee(raison)) this.echecs.push(`${quoi} : ${raison}`);
  }

  evenement(m) {
    if (m.method === 'Target.attachedToTarget') this.attacher(m.params);
    else if (m.method === 'Fetch.requestPaused') this.requete(m.params);
    else if (m.method === 'Debugger.paused' && m.sessionId) {
      if (m.params.reason === 'instrumentation') this.avantPremierScript(m.sessionId);
      else this.envoyer('Debugger.resume', {}, m.sessionId).catch(rien); // un `debugger;` du code de l'app pendant ce court instant
    } else if (m.method === 'Runtime.bindingCalled' && m.params.name === LIAISON) {
      try { this.noter(JSON.parse(m.params.payload)); } catch { /* charge illisible : rien */ }
    }
  }

  /** Une cible attachée en pause : un worker reçoit son prélude et l'arrêt avant son premier script ; ses cibles filles seront attachées aussi. */
  async attacher({ sessionId, targetInfo: t, waitingForDebugger }) {
    try {
      if (!TYPES_DOCUMENT.includes(t.type) && !TYPES_WORKER.includes(t.type)) return;
      if (TYPES_WORKER.includes(t.type)) await this.garderWorker(sessionId, t);
      await this.envoyer('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    } catch (e) {
      this.echec(`${t.type} ${t.url}`, e);
    } finally {
      if (waitingForDebugger) await this.envoyer('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(rien);
    }
  }

  async garderWorker(sessionId, t) {
    await this.envoyer('Runtime.addBinding', { name: LIAISON }, sessionId);
    await this.prelude(sessionId);
    // Les interfaces réservées aux contextes sûrs (WebTransport, WebSocketStream) ne sont posées qu'après le chargement du script du worker :
    // le prélude est rejoué juste avant sa première ligne, à l'arrêt « beforeScriptExecution » (pause, rejeu, reprise).
    await this.envoyer('Debugger.enable', {}, sessionId);
    const { breakpointId } = await this.envoyer('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, sessionId);
    this.avantScript.set(sessionId, { breakpointId, quoi: `${t.type} ${t.url}` });
    if (this.passe) this.workers.push({ type: t.type, url: t.url });
  }

  async prelude(sessionId) {
    const r = await this.envoyer('Runtime.evaluate', { expression: PRELUDE_WORKER }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }

  /** Arrêt avant le premier script d'un worker : prélude rejoué, arrêt retiré, débogueur coupé, le worker repart. */
  async avantPremierScript(sessionId) {
    const a = this.avantScript.get(sessionId);
    if (!a) return this.envoyer('Debugger.resume', {}, sessionId).catch(rien); // déjà traité
    this.avantScript.delete(sessionId);
    try {
      await this.prelude(sessionId);
    } catch (e) {
      this.echec(a.quoi, e);
    } finally {
      await this.envoyer('Debugger.removeBreakpoint', { breakpointId: a.breakpointId }, sessionId).catch(rien);
      await this.envoyer('Debugger.resume', {}, sessionId).catch(rien);
      await this.envoyer('Debugger.disable', {}, sessionId).catch(rien);
    }
  }

  requete({ requestId, request: q, resourceType }) {
    if (METHODES_LUES.includes(q.method)) return this.envoyer('Fetch.continueRequest', { requestId }).catch(rien);
    this.noter({ voie: 'http', cible: q.url, detail: `${q.method} ${q.url}`.slice(0, 120) });
    // Un formulaire POST est une navigation : 204 laisse la page où elle est (un refus la remplacerait par une page d'erreur).
    if (resourceType === 'Document') return this.envoyer('Fetch.fulfillRequest', { requestId, responseCode: 204, body: '' }).catch(rien);
    return this.envoyer('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(rien);
  }

  /** Pose le puits des écritures d'une passe ; une seule passe à la fois par navigateur. */
  ouvrirPasse(ecritures) {
    if (this.passe) throw new Error('une passe de sondes est déjà en cours sur ce navigateur');
    this.passe = ecritures;
    this.echecs = [];
    this.workers = [];
  }

  /** Retire le puits et rend le bilan de la passe : cibles non gardées, workers gardés. */
  fermerPasse() {
    const bilan = { echecs: this.echecs, workers: this.workers };
    this.passe = null;
    return bilan;
  }
}

/**
 * Arme la garde sur un navigateur lancé avec ARG_DEBOGAGE et un profil dans `dossier`. Lève si le navigateur ne se laisse pas garder (alors rien ne
 * doit être sondé). Le puits d'une passe se pose par `garde.ouvrirPasse(ecritures)` et se retire par `garde.fermerPasse()`.
 */
export async function armerGarde(navigateur, dossier) {
  const garde = new Garde();
  garde.cdp = await connecter(await adresseDebogage(dossier), (m) => garde.evenement(m));
  try {
    await garde.envoyer('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await garde.envoyer('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (e) {
    garde.cdp.fermer();
    throw e;
  }
  garde.fermer = () => { GARDES.delete(navigateur); garde.cdp.fermer(); };
  GARDES.set(navigateur, garde);
  return garde;
}

/**
 * Lecture seule (revue r1 : un bouton d'icône avait envoyé « DELETE item 1 » par WebSocket ; revue r2 : un Worker et un SharedWorker écrivaient
 * encore). Chaque tentative est notée { voie, cible, detail } dans `ecritures`.
 * - HTTP hors GET, HEAD, OPTIONS : refusé au réseau du navigateur, pour toute cible (page, iframe, popup, Worker, SharedWorker) : scripts/sondes-garde.mjs ;
 * - WebSocket : dans la page et ses iframes, la connexion et la réception passent, aucun message n'est transmis (routage WebSocket de Playwright) ;
 *   dans un worker, `send` est coupé avant son démarrage (garde) ;
 * - service workers refusés au contexte ; sendBeacon, RTCPeerConnection, WebTransport neutralisés dans la page (SCRIPT_LECTURE_SEULE), WebTransport
 *   et WebSocketStream dans les workers (garde).
 * Un GET qui écrit côté serveur passe : la sonde ne peut pas le reconnaître (docs/sondes-interaction.md).
 */
export async function couperLesEcritures(contexte, ecritures) {
  if (typeof contexte.routeWebSocket !== 'function') {
    throw new Error('ce Playwright ne sait pas intercepter les WebSocket (routeWebSocket, version 1.48 ou plus) : lecture seule non garantie, rien n\'est sondé');
  }
  await contexte.routeWebSocket(/.*/, (ws) => {
    ws.connectToServer();
    ws.onMessage((message) => { ecritures.push({ voie: 'websocket', cible: ws.url(), detail: String(message).slice(0, 80) }); });
  });
  await contexte.exposeFunction('__sondesEcriture', (voie, detail) => { ecritures.push({ voie, cible: '', detail }); });
  await contexte.addInitScript({ content: SCRIPT_LECTURE_SEULE });
}

/**
 * Ce que la lecture seule a couvert pendant la passe, et ce qu'elle ne couvre pas : le rapport n'affirme rien au-delà (revue r2). Une cible non gardée
 * (worker qu'on n'a pas pu couper) rend la passe non vérifiée.
 */
export function lectureSeule(r) {
  const workers = r.workers ?? [];
  const parType = ['worker', 'shared_worker', 'service_worker'].map((t) => [t, workers.filter((w) => w.type === t).length]).filter(([, k]) => k)
    .map(([t, k]) => `${k} ${t}`).join(', ');
  const lignes = [`lecture seule : HTTP hors GET/HEAD/OPTIONS refusé au réseau du navigateur (page, iframes, popups, workers) ; messages WebSocket coupés `
    + `(page et iframes : routage Playwright ; workers : avant leur démarrage) ; sendBeacon, RTCPeerConnection, WebTransport coupés ; service workers `
    + `refusés ; worker(s) gardé(s) : ${parType || 'aucun'} — non couvert : un GET qui écrit côté serveur`];
  for (const e of r.nonGardes ?? []) lignes.push(`  ✗ cible non gardée, ses écritures n'ont pas été coupées : ${e} — passe non vérifiée`);
  return lignes;
}
