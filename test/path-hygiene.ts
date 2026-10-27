import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

/** Les outils dont la suite ne doit pas dépendre : ce que le développeur a installé, ni vu en CI. */
export const INSTALLED_TOOLS = ['raf', 'cadence'];

const carries = (dir: string): boolean => INSTALLED_TOOLS.some((n) => existsSync(join(dir, n)));

const insideRepo = (dir: string, repo: string): boolean => {
  const rel = relative(resolve(repo), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * L384 : le PATH que voient les tests, sans raf ni cadence installés. Un dossier qui en porte un (hors du dépôt) est remplacé,
 * à la même place, par un miroir sous `mirrors` : des liens vers tout ce qu'il contient SAUF raf et cadence — le dossier de node
 * peut porter les deux, et l'ôter ferait perdre node. Un test qui dépendait de l'outil installé (le hook post-commit de R2 de L377)
 * rougit alors sur la machine du développeur comme en CI, et pas seulement au run publish.
 */
export function sanitizePath(path: string, repo: string, mirrors: string): { path: string; removed: string[] } {
  const removed: string[] = [];
  const dirs = path.split(delimiter).map((dir) => {
    if (!dir || insideRepo(dir, repo) || !carries(dir)) return dir;
    removed.push(dir);
    const mirror = join(mirrors, `miroir-${removed.length}`);
    mkdirSync(mirror);
    for (const name of readdirSync(dir)) {
      if (!INSTALLED_TOOLS.includes(name)) symlinkSync(join(dir, name), join(mirror, name));
    }
    return mirror;
  });
  return { path: dirs.join(delimiter), removed };
}
