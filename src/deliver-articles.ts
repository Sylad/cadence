import { relative } from 'node:path';
import { openArticleLots } from './articles.js';
import { commitPaths, dirtyPaths } from './git.js';
import { PLAN_ACTIONS, planCommitMessage } from './plan-commit.js';
import type { DeliveredCtx } from './deliver.js';

/**
 * Livraison verte (L144) : les lots livrés dont le titre est public changent ce que les articles externes racontent, on ouvre
 * donc le lot qui les rafraîchit. Le plan est commité (L388 pendant une vague, L420 aussi hors vague : le livreur lancé à la main le laissait modifié) avec les fichiers que produit `plan.onWrite`, avec
 * le gabarit `plan.commit` (sans la vague hors vague), pour ne pas laisser le plan modifié dans l'arbre — sauf si le plan ou ces fichiers l'étaient
 * déjà avant l'écriture (le lead y a des modifications que ce commit emporterait). Une erreur ici ne défait pas une livraison déjà faite.
 */
export function refreshArticles(ctx: DeliveredCtx, ids: string[], sha: string): void {
  if (!ctx.plan || !ctx.articles?.length || !ids.length) return;
  try {
    // Relu : le script du projet a pu fermer des lots ou commiter le plan depuis le départ de la livraison, save() ne doit pas l'écraser.
    const plan = ctx.plan.reloaded();
    const planFile = relative(ctx.root, plan.path);
    const held = [planFile, ...plan.produced];
    const wasDirty = dirtyPaths(ctx.root, held).length > 0;
    const wanted = new Set(ids);
    const r = openArticleLots({
      plan,
      root: ctx.root,
      rules: ctx.articles,
      delivered: plan.lots().filter((l) => wanted.has(l.id)),
      publicTitle: ctx.publicTitle ?? ((l) => l.public),
      sha,
      today: ctx.today,
    });
    for (const w of r.warnings) ctx.err(`deliver : ${w}`);
    if (r.opened.length || r.noted.length) plan.save();
    const touched = [...r.opened, ...r.noted];
    let state = 'plan modifié, à commiter';
    if (touched.length && wasDirty) {
      state = 'plan déjà modifié avant la livraison, non commité : à commiter avec vos modifications';
    } else if (touched.length) {
      const message = planCommitMessage(ctx.planCommit, { lot: touched.join(', '), action: r.opened.length ? PLAN_ACTIONS.articleOpened : PLAN_ACTIONS.articleNoted, wave: ctx.waveId });
      try {
        state = `plan commité ${commitPaths(ctx.root, [planFile, ...dirtyPaths(ctx.root, plan.produced)], message)}`;
      } catch (e) {
        state = `commit du plan refusé (${(e as Error).message}), plan modifié, à commiter`;
      }
    }
    for (const id of r.opened) ctx.out(`article à rafraîchir : ${id} « ${plan.lot(id).title} » ouvert (${state}) — à jouer dans une vague ordinaire`);
    for (const id of r.noted) ctx.out(`article à rafraîchir : ${id} déjà ouvert, titres livrés ajoutés en note (${state})`);
    for (const m of r.manual) ctx.out(`article à rafraîchir : ${m}`);
  } catch (e) {
    ctx.err(`deliver : article à rafraîchir non ouvert — ${(e as Error).message}`);
  }
}
