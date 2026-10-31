import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tempDir } from './helpers.js';

/**
 * Un « hôte » ssh pour les tests de la porte déportée (L403) : un faux `ssh` placé en tête du PATH exécute la commande demandée en local (`sh -c`),
 * dans un dossier qui joue le répertoire de connexion de l'hôte. Avec `-tt` il la lance dans sa propre session (comme le fait sshd avec un tty),
 * de sorte que tuer le `ssh` local n'arrête pas la commande « distante ». git (push) passe par ce même `ssh` : le dépôt nu de l'hôte est un vrai dépôt.
 * Les appels (options et commande) sont gardés pour les assertions ; `down`, `lose` et les fichiers `nproc` / `uname-*` pilotent les pannes et la machine.
 */
export interface FakeRemote {
  dir: string;
  /** Répertoire de connexion de l'hôte. */
  home: string;
  /** L'environnement à donner à la porte : le PATH commence par le faux ssh. */
  env: Record<string, string | undefined>;
  /** Les commandes demandées à ssh, une par appel, dans l'ordre. */
  commands(): string[];
  /** Les options `-o` passées à ssh, une par ligne. */
  options(): string[];
  /** L'hôte ne répond plus (ssh sort en 255 avant toute commande). */
  down(on?: boolean): void;
  /** Toute commande qui contient l'un de ces textes est coupée : ssh sort en 255 (connexion perdue). Sans argument : rétabli. */
  lose(...patterns: string[]): void;
  /** Nombre de cœurs et plateforme que l'hôte annonce. */
  machine(m: { nproc?: number; os?: string; arch?: string }): void;
}

const SSH = `#!/bin/sh
D="$FAKE_DIR"
tty=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) printf '%s\\n' "$2" >> "$D/options.log"; shift 2;;
    -tt) tty=1; shift;;
    -p|-l|-i|-F) shift 2;;
    --) shift; break;;
    -*) shift;;
    *) break;;
  esac
done
host="$1"; shift
cmd="$*"
printf '%s\\n' "$cmd" >> "$D/commands.log"
if [ -f "$D/down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
if [ -s "$D/lose" ] && printf '%s' "$cmd" | grep -q -F -f "$D/lose"; then echo "Connection to $host closed by remote host." >&2; exit 255; fi
cd "$D/home" || exit 255
if [ "$tty" = 1 ]; then ( setsid sh -c "$cmd" ); exit $?; fi
exec sh -c "$cmd"
`;

const shim = (real: string, file: string, fallback: string): string => `#!/bin/sh\nif [ -f "$FAKE_DIR/${file}" ]; then cat "$FAKE_DIR/${file}"; else ${real ? `PATH="$FAKE_REAL_PATH" exec ${real} "$@"` : fallback}; fi\n`;

export function fakeRemote(): FakeRemote {
  const dir = tempDir();
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  script('ssh', SSH);
  script('nproc', shim('', 'nproc', 'getconf _NPROCESSORS_ONLN'));
  script('uname', `#!/bin/sh\nif [ "$1" = "-s" ] && [ -f "$FAKE_DIR/uname-s" ]; then cat "$FAKE_DIR/uname-s"; elif [ "$1" = "-m" ] && [ -f "$FAKE_DIR/uname-m" ]; then cat "$FAKE_DIR/uname-m"; else PATH="$FAKE_REAL_PATH" exec uname "$@"; fi\n`);
  const lines = (f: string): string[] => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean) : []);
  return {
    dir,
    home,
    env: { ...process.env, FAKE_DIR: dir, FAKE_REAL_PATH: process.env.PATH, PATH: `${bin}${delimiter}${process.env.PATH}` },
    commands: () => lines('commands.log'),
    options: () => lines('options.log'),
    down: (on = true) => (on ? writeFileSync(join(dir, 'down'), '') : rmSync(join(dir, 'down'), { force: true })),
    lose: (...patterns) => writeFileSync(join(dir, 'lose'), patterns.map((p) => `${p}\n`).join('')),
    machine: (m) => {
      if (m.nproc !== undefined) writeFileSync(join(dir, 'nproc'), `${m.nproc}\n`);
      if (m.os) writeFileSync(join(dir, 'uname-s'), `${m.os}\n`);
      if (m.arch) writeFileSync(join(dir, 'uname-m'), `${m.arch}\n`);
    },
  };
}
