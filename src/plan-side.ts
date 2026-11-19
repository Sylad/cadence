// Les fichiers d'un commit de plan seul vus par le hook pre-push (L784, L786) : le plan, tout ce qui vit sous `.cadence/` (registre des demandes, archives,
// notes) et ce que `plan.onWrite` régénère (`plan.onWrite.files` de cadence.yaml) ; jamais la configuration, dont les commandes de porte changent ce qui est jugé.
// Le 19-11, deux commits de plan (création d'un lot et d'une demande sous .cadence/demandes/) citant des lots ouverts étaient comptés comme du code de ces
// lots sans revue, et le sha qu'un run venait d'intégrer perdait son verdict de porte sous un tel commit.

/** Le dossier de cadence à la racine du dépôt : rien n'y est du code d'un lot. */
const CADENCE_DIR = '.cadence/';

/** Le prédicat « fichier du plan » : chemins relatifs à la racine du dépôt (`planFile`, `config`, `produced`). */
export function planSide(o: { planFile: string; config: string; produced: readonly string[] }): (file: string) => boolean {
  const produced = new Set(o.produced);
  return (f) => f !== o.config && (f === o.planFile || f.startsWith(CADENCE_DIR) || produced.has(f));
}
