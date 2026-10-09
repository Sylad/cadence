import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Day } from './dates.js';
import { isOpen, type Lot, type Plan } from './plan.js';

/** Une entrée de la clé `docs.articles` de cadence.yaml : un article d'un dépôt voisin qui raconte le projet. */
export interface ArticleRule {
  /** Dépôt voisin, relatif à la racine du projet. */
  repo: string;
  /** Fichier de l'article dans ce dépôt. */
  file: string;
  /** Nom du projet dans le titre du lot ; le nom du plan par défaut. */
  name?: string;
}

export interface Heading {
  level: number;
  text: string;
}

/** Titre du lot ouvert à la livraison. */
export const articleTitle = (name: string): string => `Article ${name} à rafraîchir`;

const SECTIONS_SHOWN = 12;

/** Titres d'un article : lignes `#` du Markdown (hors en-tête YAML) et balises `<h1>`…`<h6>` d'une page Astro ou MDX. */
export function articleHeadings(text: string): Heading[] {
  const body = text.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const found: { at: number; heading: Heading }[] = [];
  for (const m of body.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) found.push({ at: m.index!, heading: { level: m[1].length, text: m[2].trim() } });
  for (const m of body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t) found.push({ at: m.index!, heading: { level: Number(m[1]), text: t } });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.heading);
}

const words = (s: string): Set<string> =>
  new Set(
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5),
  );

/**
 * Sections à relire : celles dont le titre partage un mot (5 lettres au moins, sans accents ni casse) avec un titre public
 * livré ; sans recoupement, toutes les sections de premier niveau (`##`), faute de mieux.
 */
export function articleSections(text: string, titles: string[]): string[] {
  const headings = articleHeadings(text);
  const wanted = new Set(titles.flatMap((t) => [...words(t)]));
  const matching = headings.filter((h) => [...words(h.text)].some((w) => wanted.has(w))).map((h) => h.text);
  const picked = matching.length ? matching : headings.filter((h) => h.level === 2).map((h) => h.text);
  return picked.slice(0, SECTIONS_SHOWN);
}

export interface ArticleOpening {
  plan: Plan;
  root: string;
  rules: ArticleRule[];
  /** Lots que la livraison vient de mettre en production. */
  delivered: Lot[];
  /** Titre public d'un lot, ou rien : un lot interne ne change pas l'article. */
  publicTitle: (lot: Lot) => string | undefined;
  sha: string;
  today: Day;
}

export interface ArticleResult {
  /** Lots créés. */
  opened: string[];
  /** Lots déjà ouverts qui ont reçu une note au lieu d'un doublon. */
  noted: string[];
  /** Consignes à suivre à la main (plan tenu par un autre outil) : une par article. */
  manual: string[];
  /** Constats (article introuvable…). */
  warnings: string[];
}

/**
 * Après une livraison verte (L144) : pour chaque article déclaré, ouvre dans ce dépôt le lot « Article <projet> à rafraîchir »
 * — ou, s'il en est déjà un d'ouvert, y ajoute une note. La note cite les titres publics livrés et les sections à relire ;
 * le lot déclare le ou les dépôts voisins (`repos`, filtrés par le nom du projet : le dépôt de l'article est partagé entre projets).
 * Les entrées de même nom partagent un seul lot, qui déclare tous leurs dépôts.
 * Ne sauve pas le plan. Aucun titre public livré : rien à rafraîchir.
 */
export function openArticleLots(o: ArticleOpening): ArticleResult {
  const result: ArticleResult = { opened: [], noted: [], manual: [], warnings: [] };
  const titles = [...new Set(o.delivered.map(o.publicTitle).filter((t): t is string => !!t))];
  if (!titles.length) return result;
  // Un lot par nom de projet : deux articles de même nom (deux dépôts voisins) se jouent ensemble dans le même lot.
  const byName = new Map<string, ArticleRule[]>();
  for (const rule of o.rules) {
    const name = rule.name ?? o.plan.project;
    byName.set(name, [...(byName.get(name) ?? []), rule]);
  }
  for (const [name, rules] of byName) {
    const title = articleTitle(name);
    const repos = [...new Set(rules.map((r) => r.repo))];
    const articles = rules.map((rule) => {
      const path = resolve(o.root, rule.repo, rule.file);
      const sections = existsSync(path) ? articleSections(readFileSync(path, 'utf8'), titles) : null;
      if (sections === null) result.warnings.push(`article introuvable : ${path}`);
      return (
        `Article : ${rule.repo}/${rule.file}. ` +
        (sections === null ? 'Fichier introuvable à l\'ouverture du lot : vérifier le chemin (docs.articles). ' : `Sections à relire : ${sections.length ? sections.join(' ; ') : '(aucun titre trouvé : relire tout l\'article)'}. `)
      );
    });
    const note =
      `Livraison ${o.sha.slice(0, 7)} : titres publics livrés ${titles.map((t) => `« ${t} »`).join(', ')}. ` +
      articles.join('') +
      `Réécrire ce que ces changements rendent faux ou incomplet, sans rien inventer ; les commits ${repos.length > 1 ? 'des dépôts' : 'du dépôt'} ${repos.join(', ')} citent le lot et « ${name} ».`;
    if (o.plan.readonly) {
      result.manual.push(`${title} — plan tenu par un autre outil, ouvrir le lot avec lui : ${note}`);
      continue;
    }
    const open = o.plan.lots().find((l) => l.title === title && isOpen(l.status));
    if (open) {
      o.plan.note(open.id, note, o.today);
      result.noted.push(open.id);
      continue;
    }
    const id = o.plan.add(title, o.today, { estimate: 0.5 });
    o.plan.setRepos(id, repos.map((path) => ({ path, cite: name })));
    o.plan.note(id, note, o.today);
    result.opened.push(id);
  }
  return result;
}

export const describeArticle = (rule: ArticleRule): string => join(rule.repo, rule.file);
