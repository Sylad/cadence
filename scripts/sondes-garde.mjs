// Lecture seule des sondes au niveau du navigateur (L778, revues r2 et r3).
// r2 : un Worker dédié et un SharedWorker écrivaient sur le serveur ; le routage Playwright du contexte ne voit ni les requêtes d'un SharedWorker ni
// les WebSocket d'un worker, et ses scripts d'initialisation ne s'exécutent pas dans les workers. La garde parle donc au navigateur par le protocole
// DevTools (CDP), à côté de Playwright, sur le port de débogage que Chromium ouvre sur 127.0.0.1 :
// - HTTP : `Fetch` est activé au niveau du NAVIGATEUR, pour toute requête de toute cible ; hors GET, HEAD, OPTIONS elle est refusée avant de partir
//   (une navigation de formulaire reçoit un 204 vide : la page reste) ;
// - Workers dédiés : chaque cible est attachée EN PAUSE à son démarrage (`waitForDebuggerOnStart`, récursif) ; le prélude y est joué tout de suite,
//   puis rejoué juste avant la première ligne de son script : `send` des WebSocket ne transmet plus rien, `WebTransport` et `WebSocketStream` lèvent.
// r3 : pour un SharedWorker, ce prélude arrivait APRÈS sa première ligne (il écrivait encore par WebSocket), et WebSocketStream passait dans la page.
// Changement de mécanisme (décision du lead) : ce que la garde ne sait pas fermer à coup sûr est RETIRÉ de la page et de chaque iframe avant tout
// script (SCRIPT_LECTURE_SEULE de scripts/sondes-page.mjs : SharedWorker, WebSocketStream, WebTransport, enregistrement d'un service worker), et le
// rapport dit « fonction coupée pendant la sonde : <nom> ». Un SharedWorker ou un service worker qui démarrerait quand même rend la passe non vérifiée.
// Chaque tentative est notée { voie, cible, detail } dans le puits de la passe en cours. Une cible qu'on n'a pas pu garder est notée dans `echecs` :
// la passe est alors « non vérifiée » (scripts/sondes-interaction.mjs). Le même module coupe les WebSocket de la page (couperLesEcritures) et écrit
// les lignes « lecture seule » du rapport (lectureSeule). Méthode et limites : docs/sondes-interaction.md (Read only).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENREGISTREMENT_SW, FONCTIONS_RETIREES, MARQUE_GARDE, SCRIPT_LECTURE_SEULE } from './sondes-page.mjs';

/** L'argument de lancement de Chromium qui ouvre le port de débogage (port choisi par le système, écrit dans DevToolsActivePort du profil). */
export const ARG_DEBOGAGE = '--remote-debugging-port=0';

const METHODES_LUES = ['GET', 'HEAD', 'OPTIONS'];
const TYPES_WORKER = ['worker', 'shared_worker', 'service_worker'];
const TYPES_DOCUMENT = ['page', 'iframe'];
const LIAISON = '__sondesEcritureWorker';

/** Les workers que la garde ne sait pas couper avant leur première ligne (revue r3) : leur constructeur est retiré de la page, ils ne doivent pas démarrer. */
const TYPES_NON_FERMES = { shared_worker: 'SharedWorker est retiré de la page', service_worker: "l'enregistrement d'un service worker est refusé" };

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
    if (!this.passe) return;
    // Revue r3 : dans un SharedWorker le prélude arrive après la première ligne du script. Il est joué quand même, mais la passe n'est plus vérifiée.
    if (TYPES_NON_FERMES[t.type]) this.echecs.push(`${t.type} ${t.url} : démarré alors que ${TYPES_NON_FERMES[t.type]} ; la garde ne sait pas le couper avant sa première ligne`);
    else this.workers.push({ type: t.type, url: t.url });
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

  /** Retire le puits et rend le bilan de la passe : cibles non gardées, Workers dédiés gardés. */
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
 * Lecture seule (revue r1 : un bouton d'icône avait envoyé « DELETE item 1 » par WebSocket ; r2 : un Worker et un SharedWorker écrivaient encore ;
 * r3 : un SharedWorker et WebSocketStream écrivaient encore). Chaque tentative est notée { voie, cible, detail } dans `ecritures`.
 * - HTTP hors GET, HEAD, OPTIONS : refusé au réseau du navigateur (garde) ;
 * - WebSocket : dans la page et ses iframes, la connexion et la réception passent, aucun message n'est transmis (routage WebSocket de Playwright) ;
 *   dans un Worker dédié, `send`, WebSocketStream et WebTransport sont coupés avant sa première ligne (garde) ;
 * - SharedWorker, WebSocketStream, WebTransport retirés et enregistrement d'un service worker refusé, dans la page et chaque iframe, avant tout
 *   script (SCRIPT_LECTURE_SEULE) ; chaque demande de la page est comptée dans `coupees` ({ nom, fois }), une fonction restée en place dans `restes` ;
 * - fermé par défaut (revue r4) : une fenêtre que la page ouvre sans le marqueur du script d'initialisation est fermée et notée dans `fenetres` ;
 * - sendBeacon rend false, RTCPeerConnection lève (SCRIPT_LECTURE_SEULE) ; service workers refusés au contexte aussi ;
 * - une erreur non rattrapée de la page qui nomme un constructeur retiré est gardée dans `erreurs` : la passe est partielle.
 * Un GET qui écrit côté serveur passe : la sonde ne peut pas le reconnaître (docs/sondes-interaction.md).
 */
export async function couperLesEcritures(contexte, ecritures, { coupees = [], restes = [], erreurs = [], fenetres = [] } = {}) {
  if (typeof contexte.routeWebSocket !== 'function') {
    throw new Error('ce Playwright ne sait pas intercepter les WebSocket (routeWebSocket, version 1.48 ou plus) : lecture seule non garantie, rien n\'est sondé');
  }
  await contexte.routeWebSocket(/.*/, (ws) => {
    ws.connectToServer();
    ws.onMessage((message) => { ecritures.push({ voie: 'websocket', cible: ws.url(), detail: String(message).slice(0, 80) }); });
  });
  await contexte.exposeFunction('__sondesEcriture', (voie, detail) => { ecritures.push({ voie, cible: '', detail }); });
  await contexte.exposeFunction('__sondesCoupee', (quoi, nom, ou) => {
    if (quoi === 'fenetre') {
      return void fenetres.push(`${ou} a ouvert une fenêtre (${nom}) où le script d'initialisation n'avait pas tourné au retour de window.open ; `
        + 'elle a été fermée avant tout usage, window.open a rendu null (ce que l\'app en fait n\'est pas sondé)');
    }
    if (quoi === 'reste') return void restes.push(`${nom} dans ${ou} : fonction non retirée, la page peut encore écrire par elle`);
    const deja = coupees.find((c) => c.nom === nom);
    if (deja) deja.fois += 1; else coupees.push({ nom: String(nom), fois: 1 });
  });
  // Une page qui se sert d'un constructeur retiré sans tester sa présence lève (« SharedWorker is not a constructor ») : son script s'arrête là,
  // l'app ne tourne plus comme chez l'utilisateur. L'erreur est gardée : la passe est partielle, jamais « aucun constat » (essai minimal de r3).
  contexte.on('weberror', (w) => {
    const message = String(w.error()?.message ?? w.error()).split('\n')[0];
    if (FONCTIONS_RETIREES.some((nom) => message.includes(nom)) && !erreurs.includes(message)) erreurs.push(message);
  });
  await contexte.addInitScript({ content: SCRIPT_LECTURE_SEULE });
}

const LIRE_MARQUE = `(() => { const g = window[${JSON.stringify(MARQUE_GARDE)}]; return g ? { tot: g.tot === true } : null; })()`;
const DELAI_MARQUE = 2000;

/**
 * Fermé par défaut (revue r4) : la sonde ne tient pour gardées que les fenêtres où elle LIT le marqueur du script d'initialisation, posé avant
 * tout script du document (`tot`). Chaque page du contexte (celle de la sonde, un popup), chaque iframe, à chaque document neuf, est vérifiée ;
 * ce qui n'a pas le marqueur, l'a reçu après un script, ou s'est fermé ou détaché avant d'avoir pu être lu, entre dans `fenetres` : le rapport
 * dit « fenêtre non gardée » et la passe est non vérifiée (code 2). `bilan()` relit, à la fin de la passe, tout ce qui vit encore.
 */
export function surveillerFenetres(contexte, fenetres) {
  const etats = new Map(); // frame → 'ok' | 'non'
  const encours = new Map(); // frame → promesse de la vérification en cours
  let fini = false;
  const dire = (texte) => { if (!fini && !fenetres.includes(texte)) fenetres.push(texte); };
  const adresse = (frame) => { const u = frame.url(); return u && u !== ':' ? u : 'about:blank (jamais chargée)'; };
  const lire = async (frame) => {
    let minuterie;
    try {
      const g = await Promise.race([frame.evaluate(LIRE_MARQUE), new Promise((_, ko) => { minuterie = setTimeout(() => ko(new Error('délai')), DELAI_MARQUE); })]);
      if (g?.tot) return void etats.set(frame, 'ok');
      etats.set(frame, 'non');
      dire(`${adresse(frame)} : ${g ? "le script d'initialisation y a tourné après un script du document" : "le script d'initialisation n'y a pas tourné (marqueur absent)"}`);
    } catch { /* document remplacé, fermé ou muet : vu au document suivant, à la fermeture ou au bilan */ } finally {
      clearTimeout(minuterie);
    }
  };
  const verifier = (frame) => {
    const p = (encours.get(frame) ?? Promise.resolve()).then(() => lire(frame));
    encours.set(frame, p);
    return p;
  };
  // Un document neuf remet la preuve à zéro : c'est lui qu'il faut lire.
  const neuf = (frame) => { etats.delete(frame); void verifier(frame); };
  const parti = async (frame, quoi) => {
    await encours.get(frame);
    if (!etats.has(frame)) dire(`${adresse(frame)} : ${quoi} avant que la sonde ait pu y lire le marqueur du script d'initialisation`);
  };
  const suivre = (page) => {
    page.on('frameattached', neuf);
    page.on('framenavigated', neuf);
    page.on('framedetached', (f) => void parti(f, 'iframe retirée'));
    page.on('close', () => void parti(page.mainFrame(), 'fenêtre fermée'));
    for (const f of page.frames()) void verifier(f);
  };
  contexte.on('page', suivre);
  for (const page of contexte.pages()) suivre(page);
  return {
    /** Relit tout ce qui vit encore ; ce qui reste sans preuve est dit. À appeler avant de fermer le contexte. */
    async bilan() {
      await Promise.all([...encours.values()]);
      for (const page of contexte.pages()) {
        for (const f of page.frames()) {
          if (etats.get(f) !== 'ok' && !etats.has(f)) await verifier(f);
          if (!etats.has(f) && !page.isClosed() && !f.isDetached()) dire(`${adresse(f)} : la sonde n'a pas pu y lire le marqueur du script d'initialisation`);
        }
      }
      fini = true;
    },
  };
}

/**
 * Ce que la lecture seule a couvert pendant la passe, et ce qu'elle ne couvre pas : le rapport n'affirme rien au-delà de ce qui est mesuré (revues
 * r2 et r3). Chaque fonction retirée que la page a demandée a sa ligne « fonction coupée pendant la sonde ». Une cible non gardée (worker qu'on
 * n'a pas pu couper, SharedWorker ou service worker démarré, fonction non retirée) rend la passe non vérifiée.
 */
export function lectureSeule(r) {
  const dedies = (r.workers ?? []).filter((w) => w.type === 'worker').length;
  const lignes = [`lecture seule : HTTP hors GET/HEAD/OPTIONS refusé au réseau du navigateur (page, iframes, popups, Workers dédiés) ; messages WebSocket `
    + `de la page et des iframes non transmis (routage Playwright) ; dans un Worker dédié, send des WebSocket, WebSocketStream et WebTransport coupés avant `
    + `sa première ligne ; retirés de la page et de chaque iframe avant tout script : ${[...FONCTIONS_RETIREES, ENREGISTREMENT_SW].join(', ')} ; sendBeacon `
    + `rend false, RTCPeerConnection lève ; Worker(s) dédié(s) gardé(s) : ${dedies || 'aucun'} — non couvert : un GET qui écrit côté serveur ; WebTransport `
    + `réel (aucun serveur HTTP/3 à l'essai : seule l'absence du constructeur est vérifiée) ; la raison d'une fermeture WebSocket (close(code, raison), 123 octets au plus) atteint le serveur`,
  `  fenêtres : fermé par défaut — une page, un popup ou un iframe n'est tenu pour gardé que si la sonde y lit le marqueur du script d'initialisation, `
    + `posé avant tout script du document ; une fenêtre que la page ouvre sans ce marqueur au retour de window.open est fermée avant tout usage ; `
    + `fenêtre(s) non gardée(s) : ${(r.fenetres ?? []).length || 'aucune'}`];
  for (const e of r.fenetres ?? []) lignes.push(`  ✗ fenêtre non gardée : ${e} — passe non vérifiée`);
  for (const c of r.coupees ?? []) {
    lignes.push(`  fonction coupée pendant la sonde : ${c.nom} (demandée ${c.fois} fois par la page ou un iframe ; un test de présence compte) — ce qui en dépend dans l'app n'est pas sondé`);
  }
  for (const e of r.erreursCoupees ?? []) {
    lignes.push(`  ? erreur de la page sur une fonction coupée : ${e} — son script s'est arrêté là, l'app ne tourne pas ici comme chez l'utilisateur : passe partielle`);
  }
  for (const e of r.nonGardes ?? []) lignes.push(`  ✗ cible non gardée, ses écritures n'ont pas été coupées : ${e} — passe non vérifiée`);
  return lignes;
}
