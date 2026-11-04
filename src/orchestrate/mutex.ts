/** File d'attente en mémoire : un seul porteur à la fois, dans l'ordre des demandes (les lots d'une vague partagent un processus, donc un pid : un verrou fichier ne les départagerait pas, L279). */
export class Mutex {
  private held = false;
  private urgent: (() => void)[] = [];
  private waiters: (() => void)[] = [];

  /** Vrai quand un porteur tient le mutex : une demande ne sera pas servie tout de suite. */
  get busy(): boolean {
    return this.held;
  }

  private pass(): void {
    const next = this.urgent.shift() ?? this.waiters.shift();
    if (next) next();
    else this.held = false;
  }

  /**
   * Rend la libération quand c'est le tour du demandeur, ou null si `timeoutMs` s'écoule avant. Un demandeur qui renonce laisse passer son tour.
   * `first` (L591) : la demande passe devant celles déjà en file (jamais devant le porteur) ; les demandes `first` se servent entre elles dans l'ordre.
   */
  async acquire(timeoutMs = Infinity, first = false): Promise<(() => void) | null> {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      this.pass();
    };
    if (!this.held) {
      this.held = true;
      return release;
    }
    const line = first ? this.urgent : this.waiters;
    let timer: NodeJS.Timeout | undefined;
    const turn = await new Promise<boolean>((resolve) => {
      const mine = () => resolve(true);
      line.push(mine);
      if (timeoutMs !== Infinity)
        timer = setTimeout(() => {
          const at = line.indexOf(mine);
          if (at < 0) return; // son tour est déjà venu
          line.splice(at, 1);
          resolve(false);
        }, timeoutMs);
    });
    clearTimeout(timer);
    return turn ? release : null;
  }
}

const mutexes = new Map<string, Mutex>();

/** Le mutex nommé (un par dépôt et par usage) : même objet pour la même clé, pendant toute la vie du processus. */
export function mutexFor(key: string): Mutex {
  let m = mutexes.get(key);
  if (!m) mutexes.set(key, (m = new Mutex()));
  return m;
}
