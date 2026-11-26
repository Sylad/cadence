/** Revue L872 r2 : commandes de la revue (et leurs voisines) où un shell lit le texte cité ; jouées par le détecteur (fuites.test.ts) et par le vrai hook (lecture-obligatoire.test.ts). */
export const LUES_PAR_UN_SHELL = [
  "bash -c 'grep -rl attendu /* 2>/dev/null'", 'bash -c "grep -rl attendu /* 2>/dev/null | head"', "sh -c 'rg -l x /* 2>/dev/null'",
  "timeout 60 bash -c 'grep -rIl secret /* 2>/dev/null'", "bash <<'EOF'\ngrep -rl x /* 2>/dev/null\nEOF", "bash -c 'find /* 2>/dev/null | grep attendu'",
  "bash -c 'cp -r /* Backup'", "bash -c 'tar czf x.tgz /* 2>/dev/null'", "bash -c 'ls -R /** 2>/dev/null'", "bash -c 'du -sh /* 2>/dev/null'",
  // la forme d'un commentaire (« /* Mot ») ne suffit pas quand un shell lit le texte
  "bash -c 'grep -rl x /* Docs'", "/bin/bash -c 'cp -r /* Copie'", "sh <<EOF\ncp -r /* Sauvegarde\nEOF", "eval 'grep -rl x /* Docs'", "xargs sh -c 'grep -rl x /* Docs'",
  "echo 'grep -rl x /* Docs' | sh", "cat <<'EOF' | bash\ngrep -rl x /* Docs\nEOF", "sed 's|^|grep -rl x /* Docs #|' f | sh", "bash -c 'sed \"s|a|/* R14 */|\" f'",
  "cat > x.txt <<'EOF'\nrien\nEOF\nbash -c 'grep -rl x /* Docs'",
  // un interprète qui rend la main à un shell
  'python3 -c \'import os; os.system("grep -rl x /* Docs")\'', "python3 - <<'EOF'\nimport subprocess\nsubprocess.run('grep -rl x /* Docs', shell=True)\nEOF",
  'node -e \'require("child_process").execSync("cp -r /* Copie")\'',
];
/** Revue L872 r2 : textes lus par sed ou par un interprète non shell (dernier cas : forme réelle du 25-11 16:28, heredoc de cat effacé puis heredoc python). */
export const TEXTES_NON_SHELL = [
  "cat f.ts | sed 's|/\\* R14 \\*/|/* R15 */|'", 'node -e \'const s = "/** Texte */"; console.log(s)\'', '/usr/bin/python3 -c \'print("/* R14 */")\'',
  "./run.sh && sed 's|x|/* R14 */|' f.sh", "cd ./frontend && python3 - <<'EOF'\nanchor=\"/**\\n * R-M11\"\nEOF",
  "mkdir -p d && cat > d/D-1.json <<'EOF'\n{ \"id\": \"D-1\" }\nEOF\npython3 - <<'EOF'\nnew=\"        {/* D-1 : un trait entre les deux parties */}\"\nEOF",
];
