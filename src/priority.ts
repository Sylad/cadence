import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { Document, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { findProjects, readDepth } from './lead.js';
import { priorityRank, readPriority } from './orchestrate/continue.js';
import { RafError } from './plan.js';
import { setKey } from './config-set.js';

export interface PriorityMove {
  /** Les projets dans l'ordre où `lead tour`, `orchestrate --continue` et le panneau les rangent après le déplacement. */
  order: string[];
  /** Faux quand le projet était déjà à cette place : le fichier n'est pas touché. */
  changed: boolean;
}

/**
 * `cadence lead priority <projet> --before|--after <projet>` (L449) : place `project` juste avant ou après `target` dans l'ordre des projets du dossier,
 * en réécrivant la liste `priority:` de son cadence.yaml (créé s'il manque). Les projets sont nommés comme `lead tour` les nomme.
 * La liste écrite nomme tous les projets du dossier, dans l'ordre affiché : un nom qui en couvrait plusieurs par préfixe (`maritime` pour `maritime-atlas`) devient explicite,
 * et un nom qui ne couvre aucun projet reste en fin de liste. Le reste du fichier, commentaires compris, est gardé (setKey). Un fichier illisible, ou une clé qui n'est pas une liste, est refusé sans rien écrire.
 */
export function movePriority(parent: string, project: string, place: 'before' | 'after', target: string, depth?: number): PriorityMove {
  const file = join(parent, 'cadence.yaml');
  const declared = readPriority(parent); // refuse un yaml illisible ou une clé qui n'est pas une liste de noms
  const projects = findProjects(parent, depth ?? readDepth(parent)).map((dir) => ({ key: basename(dir), name: relative(parent, dir).split(sep).join('/') }));
  const byName = new Map(projects.map((p) => [p.name, p]));
  for (const n of [project, target]) if (!byName.has(n)) throw new RafError(`projet inconnu : ${n} (projets de ${parent} : ${projects.map((p) => p.name).join(', ') || 'aucun'})`);
  if (project === target) throw new RafError(`${project} : le même projet des deux côtés`);
  const keys = projects.map((p) => p.key);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw new RafError(`deux projets s'appellent ${twice} : la liste priority: les nomme par leur dossier et ne peut pas les distinguer`);
  const ranked = [...projects].sort((a, b) => priorityRank(a.key, declared) - priorityRank(b.key, declared) || a.key.localeCompare(b.key) || a.name.localeCompare(b.name));
  const without = ranked.filter((p) => p.name !== project);
  const at = without.findIndex((p) => p.name === target) + (place === 'after' ? 1 : 0);
  const moved = [...without.slice(0, at), byName.get(project)!, ...without.slice(at)];
  const order = moved.map((p) => p.name);
  if (order.every((n, i) => n === ranked[i]!.name)) return { order, changed: false };
  const unmatched = declared.filter((n) => !keys.some((k) => k === n || k.startsWith(`${n}-`)));
  const list = [...moved.map((p) => p.key), ...unmatched];
  // la liste écrite doit restituer l'ordre voulu : un nom qui en préfixe un autre (`shop` et `shop-web`) les rangerait ensemble
  const back = [...projects].sort((a, b) => priorityRank(a.key, list) - priorityRank(b.key, list) || a.key.localeCompare(b.key) || a.name.localeCompare(b.name)).map((p) => p.name);
  if (back.some((n, i) => n !== order[i])) {
    const clash = keys.find((k) => keys.some((o) => o !== k && o.startsWith(`${k}-`)));
    throw new RafError(`${project} ne peut pas être placé ${place === 'before' ? 'avant' : 'après'} ${target} : la liste priority: nomme un projet par son dossier, et ${clash ?? 'un nom'} est le début du nom d'un autre projet (« ${clash ?? 'x'}- »), qui le suit toujours — rien n'est écrit`);
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const old = parseDocument(text).get('priority', true);
  // les noms déjà dans la liste gardent leur nœud, donc le commentaire de leur ligne ; les autres sont des nœuds neufs
  const kept = new Map<string, Node>();
  if (isSeq(old)) for (const item of old.items) if (isScalar(item) && typeof item.value === 'string') kept.set(item.value.trim(), item);
  const value = new Document(list);
  if (isSeq(value.contents)) {
    value.contents.items = list.map((n) => kept.get(n) ?? value.createNode(n));
    value.contents.flow = isSeq(old) && old.flow === true; // la liste en ligne reste en ligne
  }
  const next = setKey(text, 'priority', value);
  if (next !== null) writeFileSync(file, next);
  return { order, changed: next !== null };
}
