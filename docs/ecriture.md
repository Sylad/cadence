# Short writing: `cadence ecriture` and the `ecriture:` key

Some texts are read without the conversation: News entries, review reports, the day's report of the lead.
They must read at first sight. `cadence ecriture` checks them against a few rules taken from ASD-STE100
(Simplified Technical English), transposed to French (L803, D-31). It **reports** and never rewrites.
The author shortens the flagged sentences. Nothing in it is specific to one repository.

## What is flagged

| Signal | Rule | Default |
|---|---|---|
| long sentence | a sentence of more than `phrase` words | 25 |
| long instruction | an instruction of more than `consigne` words | 20 |
| passive voice | « être » (or « avoir été ») followed by a past participle: « est écrit », « a été lancée » | on |
| semicolon | a `;` joins two ideas: one idea per sentence | on |

The output gives each signal with its place and an extract, then one summary line per group:

```text
docs/nouveautes/2026-11-23-x.md:9  31 mots (seuil 25) : « Dans le panneau des lots (`/hud lots`), un projet … »
docs/nouveautes/2026-11-23-x.md:11  voix passive ? (« est conservé ») : « Dans chaque groupe, l'ordre du plan est conservé. »
Nouveautés : 1 fichier, 12 phrases, 230 mots, moyenne 19,2 mots par phrase, 3 au-delà du seuil (25 %), 1 passive, 2 points-virgules
```

The **average** (words per sentence) is the measure of the lot: compare it before and after on 2 or 3 daily reports.
On 2026-11-23, the 20 News entries of cadence averaged 24,9 words per sentence, 40,6 % of them above 25.

## How the text is read

- Markdown: the front matter, headings, fenced code, HTML comments and table separators are left out.
  A paragraph, a list item and a table cell are each a block. A block always ends a sentence.
- A sentence ends at `.`, `!`, `?` or `…` followed by a blank and a capital, a digit or an opening quote.
  So « p. ex. la » and « etc. et » do not cut.
- A word is a run without blanks that holds a letter or a digit. « l'appel », « mini-blue » and an inline
  code span each count as one word. A link counts as its text, a bare URL as one word. A dash or an arrow counts for nothing.
- A JSON report (a structured review) is read string by string. Its place is the JSON path: `qa.json#constats[0].texte`.
- An instruction is recognised by its first words: an imperative in « -ez » (« Vérifiez »), an infinitive followed by
  a complement (« Lancer la commande », « Ajouter un test »), « Ne pas … », « N'… », or « il faut », « vous devez », « on doit ».
- These are heuristics. A sentence in English is measured for length only. A false passive (« est fini » as a state) is possible:
  the signal reads « voix passive ? », the author decides.

## The command

```bash
cadence ecriture                              # the News entries of the repository (docs/nouveautes/, --dir otherwise)
cadence ecriture --jour 2026-11-23            # only the entries dated that day (front matter date:); --depuis for that day and after
cadence ecriture revues/                      # files or folders: .md, .txt and .json, folders walked (no .git, no node_modules)
cadence ecriture --nouveautes revues/         # both: one summary line per group, then the total
cadence ecriture --resume                     # summary lines only
cadence ecriture --json                       # for a script: reglages, total, groupes, fichiers, signalements
cadence ecriture --strict                     # exits 1 when a signal remains
```

`--seuil n` and `--seuil-consigne n` override the thresholds for one call. The exit code is 0, or 1 with `--strict` and a signal.
It is 2 for a bad option, a bad `ecriture:` key or an unreadable file, and the cause is printed.

## The `ecriture:` key

```yaml
ecriture:
  phrase: 25          # words per sentence
  consigne: 20        # words per instruction
  passif: true        # flag the passive voice
  pointVirgule: true  # flag the semicolon
  depuis: 2026-11-23  # raf news check: only entries dated this day or after
```

Every key is optional. Without the key, the defaults above apply. A malformed key is refused by `cadence ecriture`
and by the check of `cadence.yaml` that `cadence config` runs before writing.

**`raf news check`.** When `cadence.yaml` declares `ecriture:`, `raf news check` adds one line `⚠ écriture : …` per signal
of the entries dated `depuis` or later. These lines are warnings. They do not count as gaps and block nothing.
Without the key, `raf news check` is unchanged. Old entries are not reopened.

## Review reports

The three reviewer agents (`code-reviewer`, `ux-reviewer`, `qa-reviewer`) write their reports under the same rule.
When the brief gives a `Report file:`, the agent runs `cadence ecriture <file>` after writing it.
It shortens what is flagged, then replies.

## The day's report of a parent folder

A lead may publish a daily report, for example with a script of the parent folder, outside any repository.
That script calls the command once per repository, from the repository, and once on the folder of review reports:

```bash
cadence ecriture --jour 2026-11-23 --json                        # News entries of the day: total.moyenne, total.phrases
cadence ecriture --json <folder of the day's review reports>     # the reports: groupes.fichiers.moyenne
```

In the JSON, `total` and each `groupes.<nouveautes|fichiers>` hold `phrases`, `mots`, `moyenne`, `longues`,
`consignesLongues`, `passives` and `pointsVirgules`. `fichiers` gives the same per file, `signalements` each signal
(`ou`, `type`, `mots` and `seuil` or `forme`, `texte`). The report prints the average before and after.
No file to read is not an error: the text output says « aucun fichier à lire », the JSON has `total.fichiers` 0.
