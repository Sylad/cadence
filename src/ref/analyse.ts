import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../orchestrate/snapshot.js';
import type { AgentDef, ClaudeFn, Model } from '../orchestrate/launch.js';
import { RafError } from '../plan.js';
import { add, type AddOptions } from './add.js';
import { checkInventaire, readInventaire } from './check.js';
import { assembler, parseSeuil, precedentDe, reconcilier, reprendreIds, type Reconciliation } from './diff.js';
import { troisiemeRegard } from './regard.js';
import { sessionDeRef } from './session.js';

/** Plafond déclaré d'une lecture : au plus 20 pages rendues lues d'un coup (design §5, « Taille »). Au-delà, `--sections` en choisit moins. */
export const LECTURE_PAGES_MAX = 20;

export const ANALYSE_MODELS: readonly Model[] = ['sonnet', 'opus', 'haiku'];

/** Sortie structurée de la session : ce que l'agent dit de sa lecture ; le programme ne s'y fie pas, il relit le fichier. */
export const ANALYSE_SCHEMA = {
  type: 'object',
  properties: {
    resume: { type: 'string', description: 'Two sentences: what the document is and what the reading holds.' },
    questions: { type: 'array', items: { type: 'string' }, description: 'What a human must settle: a contradiction, an element that could not be read.' },
  },
  required: ['resume', 'questions'],
  additionalProperties: false,
};

export interface AnalyseOptions extends Omit<AddOptions, 'out'> {
  model?: string;
  /** Modèle de la lecture B (défaut `opus`), avec `double` seulement. */
  modelB?: string;
  /** La double lecture (option : sa mesure n'a pas montré de gain, `docs/mesures/ref-double-lecture-2026-10-25.md`) ; sans elle, une seule lecture. */
  double?: boolean;
  /** Part d'éléments non appariés (pour cent) au-delà de laquelle la réconciliation est refusée ; défaut 30, avec `double` seulement. */
  seuil?: string;
  /** Chemin du cadence.yaml lu par les commandes de l'agent (`--config`) : celui de `references.dir`. */
  configPath: string;
  /** Dossier de Claude Code (`CLAUDE_CONFIG_DIR`, sinon `~/.claude`) : le journal d'une session coupée y est relu pour compter ses jetons. */
  claudeHome: string;
  claude: ClaudeFn;
  agents: Record<string, AgentDef>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Consigne de la lecture : tout ce que l'agent a besoin de savoir, rien de l'attendu d'un corpus, rien d'une autre lecture. */
function brief(o: { slug: string; docDir: string; pages: number[]; file: string; configPath: string }): string {
  const cadence = `node ${join(PACKAGE_ROOT, 'bin', 'cadence.js')}`;
  const config = `--config ${o.configPath}`;
  return [
    `Lis le document de référence « ${o.slug} » et écris sa lecture.`,
    '',
    `Dossier du document : ${o.docDir} (document.json : texte positionné, images, index des figures et passages qui les citent).`,
    `Pages rendues à 200 dpi (${o.pages.length}) :`,
    ...o.pages.map((n) => `- ${join(o.docDir, 'pages', `page-${n}.png`)}`),
    '',
    `Modèle du format : ${join(PACKAGE_ROOT, 'templates', 'inventaire.json')} (genre « lecture », sans la clé pages ; slug et sha256 recopiés de document.json).`,
    `Lecture à écrire : ${o.file}`,
    '',
    'Commandes :',
    `- mesurer une zone (pixels de la page rendue) : ${cadence} ref measure ${o.slug} <page> <page | x,y | x,y,l,h> --quoi couleurs|contraste|boites|texte ${config}`,
    `- valider la lecture, jusqu'à ce qu'elle passe : ${cadence} ref check ${o.file}`,
    '',
    `Ne lis que ce dossier, le modèle et les pages ci-dessus, et aucun autre fichier de ${join(o.docDir, 'lectures')} que le tien : une autre lecture du même document peut s'y trouver, la tienne doit être la seule que tu connais ; n'écris que ${o.file}. Les jetons ne sont pas à écrire : le programme les compte.`,
  ].join('\n');
}

/** « 1 page lue », « 3 pages lues ». */
const pagesLues = (n: number): string => `${n} page${n > 1 ? 's' : ''} lue${n > 1 ? 's' : ''}`;

/** Les écarts d'une lecture au-delà du schéma : le genre, et le document lu (jamais une mesure sur deux versions mêlées). */
function ecartsDeLecture(lecture: unknown, doc: { slug: string; sha256: string }): string[] {
  const l = lecture as { genre?: unknown; document?: { slug?: unknown; sha256?: unknown } };
  const out: string[] = [];
  if (l.genre !== 'lecture') out.push('genre : « lecture » attendu (une lecture, pas un inventaire)');
  if (l.document?.slug !== doc.slug) out.push(`document.slug : « ${String(l.document?.slug)} » n'est pas le document lu (${doc.slug})`);
  if (l.document?.sha256 !== doc.sha256) out.push(`document.sha256 : l'empreinte n'est pas celle du document lu (${doc.sha256.slice(0, 12)}…)`);
  return out;
}

type Obj = Record<string, any>;
type Nom = 'a' | 'b';
interface Contexte {
  o: AnalyseOptions;
  slug: string;
  docDir: string;
  doc: { slug: string; sha256: string };
  pages: number[];
  /** L'inventaire ou la lecture A que ce passage remplace, du même document : les ids de ses éléments relus sont gardés (lu avant toute suppression). */
  precedent?: Obj;
}
type Lue = { kind: 'ok'; lecture: Obj; file: string; usage: { tokens: number; modele: Model; session: string }; questions: string[] } | { kind: 'quota'; message: string } | { kind: 'refus'; problems: string[] };

/** Une lecture : une session neuve de `reference-analyst` qui écrit `lectures/<nom>.json`, relue par le programme (ref check, genre, document) ; les jetons de la session y sont posés dans `usage`. */
async function lireUne(c: Contexte, nom: Nom, model: Model): Promise<Lue> {
  const file = join(c.docDir, 'lectures', `${nom}.json`);
  rmSync(file, { force: true }); // une lecture d'un passage précédent ne passe jamais pour celle de celui-ci
  const r = await sessionDeRef({
    agent: 'reference-analyst',
    brief: brief({ slug: c.slug, docDir: c.docDir, pages: c.pages, file, configPath: c.o.configPath }),
    model,
    schema: ANALYSE_SCHEMA,
    slug: c.slug,
    docDir: c.docDir,
    configPath: c.o.configPath,
    claudeHome: c.o.claudeHome,
    claude: c.o.claude,
    agents: c.o.agents,
    onRelaunch: () => rmSync(file, { force: true }), // la lecture à moitié écrite de la session coupée ne passe pas pour celle de la neuve
    echec: 'la session de lecture a échoué',
  });
  if (r.kind === 'quota') return r;
  if (!existsSync(file)) return { kind: 'refus', problems: [`aucune lecture écrite : ${file}`] };
  let lecture: Obj;
  try {
    lecture = readInventaire(file) as Obj;
  } catch (e) {
    return { kind: 'refus', problems: [(e as Error).message] };
  }
  const schema = checkInventaire(lecture);
  const problems = schema.length > 0 ? schema : ecartsDeLecture(lecture, c.doc);
  if (problems.length > 0) return { kind: 'refus', problems };
  if (nom === 'a') reprendreIds(lecture, c.precedent); // la lecture A porte les ids que les lots citent ; B est réconciliée et renumérotée par `assembler`
  const usage = { tokens: r.tokens, modele: model, session: r.session };
  lecture.usage = usage;
  writeFileSync(file, `${JSON.stringify(lecture, null, 2)}\n`);
  const structured = r.structured as { questions?: unknown } | undefined;
  return { kind: 'ok', lecture, file, usage, questions: Array.isArray(structured?.questions) ? structured.questions.map(String) : [] };
}

const confiancesDe = (lecture: Obj): string => ['mesure', 'lu', 'incertain'].map((c) => [c, (lecture.elements as { confiance: string }[]).filter((e) => e.confiance === c).length] as const).filter(([, n]) => n > 0).map(([c, n]) => `${c} : ${n}`).join(', ');

/** Les fichiers d'un document que ce passage supprime ou réécrit, et où le lead a pu écrire ses `exclusions` (relatifs au dossier du document). */
const FICHIERS_REMPLACES = ['inventaire.json', 'lectures/a.json', 'lectures/b.json'];

/**
 * Les `exclusions` écrites à la main dans les fichiers que ce passage va remplacer sont gardées à côté (`exclusions-<date>.json`, une clé par fichier) et
 * dites au lead : `references.dir` est hors du dépôt, rien d'autre ne les retrouverait. Sans exclusion écrite, rien n'est écrit ni dit.
 */
function garderExclusions(docDir: string, now: Date, out: (line: string) => void): void {
  const gardees: Record<string, unknown[]> = {};
  for (const nom of FICHIERS_REMPLACES) {
    try {
      const x = (JSON.parse(readFileSync(join(docDir, nom), 'utf8')) as { exclusions?: unknown }).exclusions;
      if (Array.isArray(x) && x.length > 0) gardees[nom] = x;
    } catch {
      // absent ou illisible : il n'y a rien à garder
    }
  }
  const noms = Object.keys(gardees);
  if (noms.length === 0) return;
  const file = join(docDir, `exclusions-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(gardees, null, 2)}\n`);
  out(`attention : ${Object.values(gardees).reduce((n, x) => n + x.length, 0)} exclusion(s) écrite(s) dans ${noms.join(', ')}, remplacé(s) par ce passage : gardée(s) dans ${file}`);
}

/**
 * `cadence ref analyse` : la chaîne — add, puis UNE lecture (une session de l'agent `reference-analyst`, `lectures/a.json`) ; avec `--double`, deux lectures
 * indépendantes (A et B, modèles possiblement différents), `ref diff` (réconciliation par le programme), le troisième regard sur ce qu'une seule lecture
 * porte, l'inventaire écrit avec les jetons posés dans `usage` (la double lecture n'a pas montré de gain : c'est une option, pas le défaut). Rend le code de sortie : 0 fait, 1 lecture refusée ou trop d'éléments non
 * appariés ou aucun élément gardé par le troisième regard, 3 quota ; une session en échec ou un refus d'entrée (modèle, plafond, aucune page) lève une `RafError` (code 2).
 */
export async function analyse(o: AnalyseOptions): Promise<number> {
  const model = (o.model ?? 'sonnet') as Model;
  const modelB = (o.modelB ?? 'opus') as Model;
  if (!ANALYSE_MODELS.includes(model)) throw new RafError(`ref analyse : --model invalide : « ${o.model} » (attendu : ${ANALYSE_MODELS.join(', ')})`);
  if (!ANALYSE_MODELS.includes(modelB)) throw new RafError(`ref analyse : --model-b invalide : « ${o.modelB} » (attendu : ${ANALYSE_MODELS.join(', ')})`);
  if (!o.double && o.modelB !== undefined) throw new RafError('ref analyse : --model-b n\'a de sens qu\'avec --double (une seule lecture, pas de lecture B)');
  if (!o.double && o.seuil !== undefined) throw new RafError('ref analyse : --seuil n\'a de sens qu\'avec --double (une seule lecture, rien à réconcilier)');
  const seuil = parseSeuil(o.seuil, 'ref analyse');
  const { slug, docDir, doc, lues: pages } = add({ document: o.document, slug: o.slug, sections: o.sections, env: o.env, cwd: o.cwd, refsDir: o.refsDir, now: o.now, out: o.out });
  const sections = `\n  choisir les pages à lire : cadence ref analyse ${o.document} --slug ${slug} --sections 3-12`;
  if (pages.length === 0) throw new RafError(`ref analyse : aucune page rendue : rien à lire${sections}`);
  if (pages.length > LECTURE_PAGES_MAX) throw new RafError(`ref analyse : ${pages.length} pages ${o.sections === undefined ? 'rendues' : 'à lire (--sections et les figures qu\'elles citent)'}, plafond d'une lecture : ${LECTURE_PAGES_MAX} pages${sections}`);
  // avant de supprimer ou de réécrire quoi que ce soit : l'inventaire, sinon la lecture A du passage précédent, donne ses ids à celui-ci
  const precedent = precedentDe(join(docDir, 'inventaire.json'), join(docDir, 'lectures', 'a.json'));
  const c: Contexte = { o, slug, docDir, doc, pages, precedent };
  const refuse = (problems: string[], prefixe = ''): number => {
    for (const p of problems) o.out(`✗ ${prefixe}${p}`);
    o.out(`${problems.length} écart(s)`);
    return 1;
  };

  garderExclusions(docDir, o.now, o.out);

  if (!o.double) {
    // les fichiers d'une double lecture précédente ne passent pas pour ceux de ce passage : leur `usage.lectures.a` ne serait plus celui de `a.json`
    rmSync(join(docDir, 'lectures', 'b.json'), { force: true });
    rmSync(join(docDir, 'inventaire.json'), { force: true });
    const r = await lireUne(c, 'a', model);
    if (r.kind === 'quota') {
      o.err(`ref analyse : quota atteint, aucune lecture écrite : ${r.message}`);
      return 3;
    }
    if (r.kind === 'refus') return refuse(r.problems);
    o.out(`${slug} : lecture unique (${model}) — ${pagesLues(pages.length)} (plafond d'une lecture : ${LECTURE_PAGES_MAX})`);
    o.out(`lecture : ${r.file}`);
    o.out(`éléments : ${r.lecture.elements.length} (${confiancesDe(r.lecture)})`);
    o.out(`tokens : ${r.usage.tokens} (${Math.round(r.usage.tokens / pages.length)} par page, ${pagesLues(pages.length)})`);
    for (const q of r.questions) o.out(`question : ${q}`);
    return 0;
  }

  const inventaire = join(docDir, 'inventaire.json');
  rmSync(inventaire, { force: true }); // l'inventaire d'un passage précédent ne passe jamais pour celui de celui-ci
  // deux sessions qui ne se voient pas : lancées ensemble, chacune écrit sa lecture ; un échec n'interrompt pas l'autre
  const [ra, rb] = await Promise.allSettled([lireUne(c, 'a', model), lireUne(c, 'b', modelB)]);
  for (const r of [ra, rb]) if (r.status === 'rejected') throw r.reason;
  const [a, b] = [ra, rb].map((r) => (r as PromiseFulfilledResult<Lue>).value);
  const lues = [['A', a!], ['B', b!]] as const;
  for (const [nom, r] of lues) {
    if (r.kind === 'quota') {
      o.err(`ref analyse : quota atteint (lecture ${nom}), aucune réconciliation : ${r.message}`);
      return 3;
    }
  }
  const refus = lues.flatMap(([nom, r]) => (r.kind === 'refus' ? r.problems.map((p) => `lecture ${nom} : ${p}`) : []));
  if (refus.length > 0) return refuse(refus);
  const [la, lb] = [a, b] as [Lue & { kind: 'ok' }, Lue & { kind: 'ok' }];

  const rec: Reconciliation = reconcilier(la.lecture, lb.lecture, seuil);
  const pct = (x: number): string => `${Number((x * 100).toFixed(1))} %`;
  const compteRec = `concordants ${rec.concordants} · divergents ${rec.divergents} · seuls ${rec.seuls} · silences ${rec.silences}`;
  if (rec.refuse) {
    o.out(`${slug} : double lecture (A ${model}, B ${modelB}) — ${pagesLues(pages.length)} (plafond d'une lecture : ${LECTURE_PAGES_MAX})`);
    o.out(`réconciliation : ${compteRec} — non appariés ${pct(rec.ratio!)} (seuil ${pct(seuil)})`);
    o.out(`plus de ${pct(seuil)} d'éléments non appariés (${rec.nonApparies} sur ${rec.concordants + rec.divergents + rec.seuls}) : les deux lectures ne décrivent pas le même document — question au lead, aucune réconciliation (les lectures restent dans ${join(docDir, 'lectures')}, \`cadence ref diff\` les compare)`);
    return 1;
  }

  const seuls = rec.items.filter((i) => i.statut === 'seul');
  let regard: { tokens: number; session: string; questions: string[] } | undefined;
  if (seuls.length > 0) {
    const r = await troisiemeRegard({ seuls, model, slug, docDir, configPath: o.configPath, claudeHome: o.claudeHome, claude: o.claude, agents: o.agents });
    if (r.kind === 'quota') {
      o.err(`ref analyse : quota atteint pendant le troisième regard, aucun inventaire écrit (les lectures A et B sont gardées) : ${r.message}`);
      return 3;
    }
    seuls.forEach((item, i) => (item.decision = r.decisions[i]));
    regard = r;
  }
  const inv = assembler(la.lecture, lb.lecture, rec, regard !== undefined, precedent);
  if (inv.elements.length === 0) {
    // tout ce que les lectures portent n'était porté que par une seule d'entre elles et le troisième regard l'a écarté : rien à écrire, ce n'est pas un défaut de cadence
    o.out(`${slug} : double lecture (A ${model}, B ${modelB}) — ${pagesLues(pages.length)} (plafond d'une lecture : ${LECTURE_PAGES_MAX})`);
    o.out(`réconciliation : ${compteRec}`);
    o.out(`le troisième regard a écarté tous les éléments : aucun inventaire — question au lead (les lectures restent dans ${join(docDir, 'lectures')}, \`cadence ref diff\` les compare)`);
    return 1;
  }
  // la réconciliation ne produit que des éléments déjà valides : un écart ici est un défaut de cadence, jamais une lecture à refuser
  const problems = checkInventaire(inv);
  if (problems.length > 0) throw new RafError(`ref analyse : l'inventaire réconcilié est invalide (défaut de cadence) : ${problems[0]}`);

  const tokens = la.usage.tokens + lb.usage.tokens + (regard?.tokens ?? 0);
  inv.usage = {
    tokens,
    lectures: { a: { tokens: la.usage.tokens, modele: model }, b: { tokens: lb.usage.tokens, modele: modelB }, ...(regard ? { regard: { tokens: regard.tokens, modele: model } } : {}) },
  };
  const verdicts = seuls.flatMap((item) => (item.decision ? [{ lecture: item.lecture!, id: item.element.id as string, verdict: item.decision.verdict, raison: item.decision.raison }] : []));
  inv.reconciliation = { concordants: rec.concordants, divergents: rec.divergents, seuls: rec.seuls, silences: rec.silences, non_apparies: rec.ratio, regard: verdicts };
  writeFileSync(inventaire, `${JSON.stringify(inv, null, 2)}\n`);

  const confirmes = verdicts.filter((v) => v.verdict === 'confirme').length;
  const ecartes = verdicts.length - confirmes;
  o.out(`${slug} : double lecture (A ${model}, B ${modelB}) — ${pagesLues(pages.length)} (plafond d'une lecture : ${LECTURE_PAGES_MAX})`);
  o.out(`lectures : ${la.file}, ${lb.file}`);
  o.out(`réconciliation : ${compteRec} — non appariés ${rec.ratio === null ? 'n/a' : pct(rec.ratio)} (seuil ${pct(seuil)})`);
  if (regard) o.out(`troisième regard (${model}) : ${confirmes} confirmé${confirmes > 1 ? 's' : ''}, ${ecartes} écarté${ecartes > 1 ? 's' : ''}, ${seuls.length - verdicts.length} sans réponse`);
  o.out(`inventaire : ${inventaire}`);
  o.out(`éléments : ${inv.elements.length} (${confiancesDe(inv)})`);
  o.out(`tokens : ${tokens} (${Math.round(tokens / pages.length)} par page, ${pagesLues(pages.length)}) — A : ${la.usage.tokens}, B : ${lb.usage.tokens}${regard ? `, troisième regard : ${regard.tokens}` : ''}`);
  for (const q of new Set([...la.questions, ...lb.questions, ...(regard?.questions ?? [])])) o.out(`question : ${q}`);
  return 0;
}
