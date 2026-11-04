/** File d'attente en mémoire : un seul porteur à la fois, dans l'ordre des demandes (les lots d'une vague partagent un processus, donc un pid : un verrou fichier ne les départagerait pas, L279). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  /** Vrai quand un porteur ou un demandeur précède le prochain : sa demande ne sera pas servie tout de suite. */
  get busy(): boolean {
    return this.queued > 0;
  }

  /** Rend la libération quand c'est le tour du demandeur, ou null si `timeoutMs` s'écoule avant. Un demandeur qui renonce laisse passer son tour. */
  async acquire(timeoutMs = Infinity): Promise<(() => void) | null> {
    const prev = this.tail;
    let release!: () => void;
    this.queued++;
    const mine = new Promise<void>((r) => (release = () => (this.queued--, r())));
    this.tail = prev.then(() => mine);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((r) => {
      if (timeoutMs !== Infinity) timer = setTimeout(() => r(false), timeoutMs);
    });
    const turn = await Promise.race([prev.then(() => true as const), late]);
    clearTimeout(timer);
    if (turn) return release;
    void prev.then(release);
    return null;
  }
}

const mutexes = new Map<string, Mutex>();

/** Le mutex nommé (un par dépôt et par usage) : même objet pour la même clé, pendant toute la vie du processus. */
export function mutexFor(key: string): Mutex {
  let m = mutexes.get(key);
  if (!m) mutexes.set(key, (m = new Mutex()));
  return m;
}
