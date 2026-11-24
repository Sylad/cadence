import { RafError } from './plan.js';
import { readYamlKey } from './yaml-keys.js';

// Langue des fichiers que cadence écrit DANS le projet (L791, issue #67) : gabarits copiés, fiches de spec, tests d'acceptation.
// Le plan et les messages à l'humain gardent leur langue : la clé ne touche que ce qui est commité dans le code du projet.

/** Les langues connues de la clé `language:` de cadence.yaml. Absente : le comportement d'avant (gabarits et états en français). */
export const LANGUAGES = ['fr', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** La clé `language:` (racine de cadence.yaml) : `undefined` quand elle manque, une erreur quand elle ne vaut ni `fr` ni `en`. */
export function readLanguage(file: string): Language | undefined {
  const v = readYamlKey(file, 'language');
  if (v == null) return undefined;
  if (typeof v !== 'string' || !(LANGUAGES as readonly string[]).includes(v)) throw new RafError(`${file} : language : ${LANGUAGES.join(' ou ')} attendu (reçu « ${String(v)} »)`);
  return v as Language;
}

/** Le nom des états d'une fiche d'écran dans la langue du projet : les trois requis, et l'état chargé. */
interface StateNames {
  vide: string;
  chargement: string;
  erreur: string;
  charge: string;
}

const STATES: Record<Language, StateNames> = {
  fr: { vide: 'vide', chargement: 'chargement', erreur: 'erreur', charge: 'charge' },
  en: { vide: 'empty', chargement: 'loading', erreur: 'error', charge: 'loaded' },
};

/** Les noms d'états d'une langue ; sans langue, les noms français d'avant. */
export const statesOf = (lang?: Language): StateNames => STATES[lang ?? 'fr'];

/** Les états qu'une fiche porte au moins, dans la langue du projet. */
export const requiredStates = (lang?: Language): string[] => {
  const s = statesOf(lang);
  return [s.vide, s.chargement, s.erreur];
};

/** Le nom de fichier d'un gabarit du paquet dans la langue du projet : `fiche.yaml` → `fiche.en.yaml` en anglais, inchangé sinon. */
export const templateName = (name: string, lang?: Language): string => (lang === 'en' ? name.replace(/(\.[^.]+)$/, '.en$1') : name);

/**
 * Consigne de langue des briefs qui écrivent dans le projet (spec, accept) ; vide sans langue ou en français (le comportement d'avant).
 * `step` : `spec` (fiche, maquette) ou `accept` (tests d'acceptation, lanceur copié).
 */
export function languageText(lang: Language | undefined, step: 'spec' | 'accept'): string {
  if (lang !== 'en') return '';
  const s = statesOf('en');
  const common = 'Language of the project files: English (`language: en` in `cadence.yaml`). Every comment, test name, rule statement, label, description and documentation line you write into the repository is in English, with no French word. Only the texts the product shows on screen (a `message` of the sheet, the texts of the mockup, the sample data) keep the language of the product\'s existing screens, since a test asserts them exactly.';
  const after = 'The keys of the sheet stay as the template names them (`ecran`, `etats`, `regles`, `enonce`…: they are the format `cadence spec check` reads), and your report to the lead (the structured output) is not a project file.';
  if (step === 'spec') {
    return [
      common,
      `In the sheet: \`titre\`, \`libelle\`, \`enonce\`, \`source\`, \`si_faux\`, the planned test names (\`R1 — empty state: the message is shown\`) and the cases are written in English; the states are named \`${s.vide}\`, \`${s.chargement}\`, \`${s.erreur}\` (all three required) and \`${s.charge}\` when the screen has data, so the sections of the mockup are \`#etat-${s.vide}\`, \`#etat-${s.chargement}\`, \`#etat-${s.erreur}\`, \`#etat-${s.charge}\` and the captures \`maquette-${s.vide}-1440.png\`…; \`masque\` belongs to a rule of the \`${s.vide}\` state.`,
      after,
    ].join(' ');
  }
  return [
    common,
    'The test names are exactly the English names the sheet plans (`regles[].tests`); the comment above each assertion cites the rule in English (`// R4 — "<sentence of the rule>"`); the runner template below is the English one, copy it as is.',
    after,
  ].join(' ');
}
