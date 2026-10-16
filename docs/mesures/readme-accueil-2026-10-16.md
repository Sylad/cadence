# Mesure : le README devient une page d'accueil (L232)

Remarque de Sylvain du 16-10 : le README, publié tel quel dans le paquet npm, était illisible pour un humain.

| | Avant | Après |
|---|---|---|
| `README.md` | 208 101 octets (1 762 lignes) | 5 230 octets |
| « What's new » | un paragraphe de 13 ko | une ligne par version (1.6.0 à 1.0.0), le reste dans `docs/whats-new.md` |
| Contenu | tout dans le README | repris sans suppression dans 15 pages `docs/` (raf, orchestrate, deliver, spec, lead, stabilite, news, session, corrections, skills, cadence-hud, releasing, overview, whats-new) |
| Liens relatifs et ancres cassés | non contrôlés | 0, contrôlés par `node scripts/check-links.mjs` (étape de `.github/workflows/tests.yml`, et `test/readme-accueil.test.ts`) |

Le paquet npm publie les pages `docs/` que le README cite (champ `files` de `package.json`).
