import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../config.js';
import { PACKAGE_ROOT } from '../orchestrate/snapshot.js';
import { journalTokens, runSession, type AgentDef, type ClaudeFn, type Model } from '../orchestrate/launch.js';
import { sumTokens } from '../orchestrate/result.js';
import { RafError } from '../plan.js';
import { add, type AddOptions } from './add.js';
import { checkInventaire, readInventaire } from './check.js';
import { readDocument } from './store.js';

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
  /** Chemin du cadence.yaml lu par les commandes de l'agent (`--config`) : celui de `references.dir`. */
  configPath: string;
  /** Dossier de Claude Code (`CLAUDE_CONFIG_DIR`, sinon `~/.claude`) : le journal d'une session coupée y est relu pour compter ses jetons. */
  claudeHome: string;
  claude: ClaudeFn;
  agents: Record<string, AgentDef>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Consigne de la lecture : tout ce que l'agent a besoin de savoir, rien de l'attendu d'un corpus. */
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
    `Ne lis que ce dossier, le modèle et les pages ci-dessus ; n'écris que ${o.file}. Les jetons ne sont pas à écrire : le programme les compte.`,
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

/**
 * `cadence ref analyse` : la chaîne en lecture unique — add, une session de l'agent `reference-analyst`, validation de sa lecture par le
 * programme, jetons posés dans `usage`. Rend le code de sortie : 0 lecture valide, 1 lecture refusée, 3 quota ; une session en échec ou un
 * refus d'entrée (modèle, plafond, aucune page) lève une `RafError` (code 2).
 */
export async function analyse(o: AnalyseOptions): Promise<number> {
  const model = (o.model ?? 'sonnet') as Model;
  if (!ANALYSE_MODELS.includes(model)) throw new RafError(`ref analyse : --model invalide : « ${o.model} » (attendu : ${ANALYSE_MODELS.join(', ')})`);
  const { slug, docDir, doc, lues: pages } = add({ document: o.document, slug: o.slug, sections: o.sections, env: o.env, cwd: o.cwd, refsDir: o.refsDir, now: o.now, out: o.out });
  const sections = `\n  choisir les pages à lire : cadence ref analyse ${o.document} --slug ${slug} --sections 3-12`;
  if (pages.length === 0) throw new RafError(`ref analyse : aucune page rendue : rien à lire${sections}`);
  if (pages.length > LECTURE_PAGES_MAX) throw new RafError(`ref analyse : ${pages.length} pages ${o.sections === undefined ? 'rendues' : 'à lire (--sections et les figures qu\'elles citent)'}, plafond d'une lecture : ${LECTURE_PAGES_MAX} pages${sections}`);

  const file = join(docDir, 'lectures', 'a.json');
  rmSync(file, { force: true }); // une lecture d'un passage précédent ne passe jamais pour celle de celui-ci
  const config = readOrchestrateConfig(o.configPath);
  const outcome = await runSession(
    {
      kind: 'ref',
      sessionId: randomUUID(),
      brief: brief({ slug, docDir, pages, file, configPath: o.configPath }),
      model,
      effort: config.effort.review,
      schema: ANALYSE_SCHEMA,
      agent: 'reference-analyst',
      cwd: docDir,
      wave: `ref-${slug}`,
      permissionMode: config.permissionMode,
      addDirs: [docDir],
      timeoutMs: config.timeouts.work,
    },
    {
      claude: o.claude,
      agents: o.agents,
      onRelaunch: () => rmSync(file, { force: true }), // la lecture à moitié écrite de la session coupée ne passe pas pour celle de la neuve
    },
  );
  if (outcome.kind === 'quota') {
    o.err(`ref analyse : quota atteint, aucune lecture écrite : ${outcome.message}`);
    return 3;
  }
  if (outcome.kind === 'failed') throw new RafError(`ref analyse : la session de lecture a échoué : ${outcome.cause}`);

  const refuse = (problems: string[]): number => {
    for (const p of problems) o.out(`✗ ${p}`);
    o.out(`${problems.length} écart(s)`);
    return 1;
  };
  if (!existsSync(file)) return refuse([`aucune lecture écrite : ${file}`]);
  let lecture: Record<string, any>;
  try {
    lecture = readInventaire(file) as Record<string, any>;
  } catch (e) {
    return refuse([(e as Error).message]);
  }
  const schema = checkInventaire(lecture);
  const problems = schema.length > 0 ? schema : ecartsDeLecture(lecture, doc);
  if (problems.length > 0) return refuse(problems);

  // les jetons de la session coupée (son journal) s'ajoutent à ceux de la relance, comme dans orchestrate
  const cut = outcome.relaunched ? journalTokens(o.claudeHome, docDir, outcome.relaunched.sessionId) : null;
  const tokens = cut ? sumTokens(cut.tokens, outcome.result.tokens).counted : outcome.result.tokens.counted;
  lecture.usage = { tokens, modele: model, session: outcome.result.sessionId };
  writeFileSync(file, `${JSON.stringify(lecture, null, 2)}\n`);

  const confiances = ['mesure', 'lu', 'incertain'].map((c) => [c, (lecture.elements as { confiance: string }[]).filter((e) => e.confiance === c).length] as const).filter(([, n]) => n > 0);
  o.out(`${slug} : lecture unique (${model}) — ${pagesLues(pages.length)} (plafond d'une lecture : ${LECTURE_PAGES_MAX})`);
  o.out(`lecture : ${file}`);
  o.out(`éléments : ${lecture.elements.length} (${confiances.map(([c, n]) => `${c} : ${n}`).join(', ')})`);
  o.out(`tokens : ${tokens} (${Math.round(tokens / pages.length)} par page, ${pagesLues(pages.length)})`);
  const structured = outcome.result.structured as { questions?: unknown } | undefined;
  for (const q of Array.isArray(structured?.questions) ? structured.questions : []) o.out(`question : ${String(q)}`);
  return 0;
}
