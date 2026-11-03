import { type LotCtx, stop } from './ctx.js';
import { dropped, DROPPED } from './budget.js';
/** Formes connues de « pas de question » : l'entrée entière, normalisée, doit en égaler une (liste fermée, L52). */
const NON_QUESTIONS = new Set([
  '', 'vide', '(vide)', 'n/a', 'na', 'none', 'nothing', 'nil', 'rien', 'néant', 'neant', 'aucune', 'aucun',
  'aucune question', 'aucune autre question', 'aucune question bloquante', 'aucune question supplémentaire', 'aucune question supplementaire',
  'pas de question', 'pas de questions', 'pas de question bloquante', 'pas de questions bloquantes', 'plus de question', 'plus de questions',
  "je n'ai pas de question", "je n'ai pas de questions", "je n'ai aucune question", "je n'ai pas de question bloquante", "je n'ai pas de questions bloquantes", "je n'ai aucune question bloquante",
  'no question', 'no questions', 'no open question', 'no open questions', 'no blocking question', 'no blocking questions',
  'no other question', 'no other questions', 'no further question', 'no further questions',
  'i have no question', 'i have no questions', 'i have no blocking question', 'i have no blocking questions', 'there are no questions', 'there is no question',
]);

/** Casse, espaces, ponctuation finale (hors « ? ») et apostrophe typographique ramenés à la forme de comparaison. */
function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').replace(/[\s.!:;,\-–—…]+$/u, '');
}

/** Une « question » vide ou qui dit exactement qu'il n'y en a pas (« aucune question », « no questions », « n/a ») n'arrête pas le lot ; une entrée qui contient « ? » n'est jamais filtrée. */
export function isNonQuestion(q: string): boolean {
  if (q.includes('?')) return false;
  return NON_QUESTIONS.has(normalizeQuestion(q));
}

/** Fin de vague (L79) : un lot qui a posé sa question PENDANT la vague, puis retiré par `--drop`, n'a plus de cycle à jouer pour s'en apercevoir : il est rendu ici, sinon il resterait en question pour toujours. */
export function handBackDroppedQuestions(ctxs: LotCtx[]): void {
  for (const c of ctxs) if (c.lot.status === 'question' && dropped(c)) stop(c, 'handed-back', DROPPED);
  // Les lots restés en file derrière un lot retiré ne seront jamais joués (comme le pool pour une dépendance rendue au lead) : rendus aussi, de proche en proche.
  for (let moved = true; moved; ) {
    moved = false;
    for (const c of ctxs) {
      if (c.lot.steps.length || (c.lot.status !== 'queued' && c.lot.status !== 'suspended')) continue;
      const dead = (c.lot.dependsOn ?? []).filter((id) => {
        const d = ctxs.find((o) => o.lot.project === c.lot.project && o.lot.lot === id);
        return d?.lot.status === 'handed-back' || d?.lot.status === 'failed';
      });
      if (dead.length === 0) continue;
      stop(c, 'handed-back', `dépendance non prête dans la vague : ${dead.join(', ')}`);
      moved = true;
    }
  }
}