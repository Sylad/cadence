// `cadence corrections --classify` : le classement des causes puis des sous-causes par Ollama, et son bilan (L575, sorti de stats-commands.ts).
import { existsSync, writeFileSync } from 'node:fs';
import { classifyAll, classifySous, bugCodePasses, ollamaClassifier, ollamaSousClassifier, serializeCache, serializeSousCache, type Classification, type FixPass, type SousClassification } from '../corrections.js';
import { FailureTally, UNREACHABLE, unclassifiedLine } from '../corrections-echecs.js';
import { type Io } from './context.js';

interface ClassifyRun { passes: FixPass[]; cache: Map<string, Classification>; sousCache: Map<string, SousClassification>; cacheFile: string; sousFile: string; model: string; url: string }

/**
 * Rend 0, ou 1 quand rien n'a pu être classé faute d'Ollama (une ligne dès la première passe, aucun fichier écrit) ou faute de réponse exploitable.
 * Un classement partiel rend 0 avec le compte des passes non classées et la raison ; corrections.json n'est écrit que si une passe y est entrée.
 */
export async function classify({ passes, cache, sousCache, cacheFile, sousFile, model, url }: ClassifyRun, io: Io): Promise<number> {
  const causeTodo = passes.filter((p) => p.findings.length > 0 && !cache.has(p.key)).length;
  const causeTally = new FailureTally();
  const sizeBefore = cache.size;
  const save = () => {
    if (cache.size > sizeBefore) writeFileSync(cacheFile, serializeCache(cache));
  };
  const classees = await classifyAll(passes, cache, ollamaClassifier({ url, model, onFail: causeTally.add }), model, (done, total) => {
    if (done % 25 === 0 || done === total) io.err(`classement : ${done}/${total}`);
  }, { every: 10, save, stop: () => cache.size === sizeBefore && causeTally.count(UNREACHABLE) > 0 });
  if (causeTodo > 0 && classees === 0 && causeTally.count(UNREACHABLE) > 0) {
    io.err(`Ollama injoignable sur ${url} : rien n'est classé`);
    return 1;
  }
  // Rien à classer et pas de fichier : il est créé vide, comme avant ; un fichier existant n'est jamais réécrit par un résultat vide.
  if (cache.size > sizeBefore || (causeTodo === 0 && !existsSync(cacheFile))) writeFileSync(cacheFile, serializeCache(cache));
  if (classees < causeTodo) io.err(unclassifiedLine('classement', causeTodo - classees, causeTodo, causeTally));
  if (causeTodo > 0 && classees === 0) return 1;
  const sousTally = new FailureTally();
  const sousTodo = bugCodePasses(passes, cache).filter((p) => !sousCache.has(p.key)).length;
  const saveSous = () => writeFileSync(sousFile, serializeSousCache(sousCache));
  const added = await classifySous(passes, cache, sousCache, ollamaSousClassifier({ url, model, onFail: sousTally.add }), model, (done, total) => {
    if (done % 25 === 0 || done === total) io.err(`sous-causes : ${done}/${total}`);
  }, { every: 10, save: saveSous });
  if (added > 0) saveSous();
  if (added < sousTodo) io.err(unclassifiedLine('sous-causes', sousTodo - added, sousTodo, sousTally));
  return 0;
}
