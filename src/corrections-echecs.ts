// Les raisons des réponses perdues d'un classement par Ollama et le bilan qui les nomme (L575, issue #35).

/** La raison d'un échec réseau (hôte éteint, connexion refusée). */
export const UNREACHABLE = 'Ollama injoignable';

/** Compte les raisons des réponses perdues : « réponse HTTP 500 ×2, réponse hors liste ×1 ». */
export class FailureTally {
  private readonly counts = new Map<string, number>();
  readonly add = (reason: string): void => void this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  count(reason: string): number {
    return this.counts.get(reason) ?? 0;
  }
  render(): string {
    return [...this.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r, n]) => `${r} ×${n}`).join(', ');
  }
}

/** La ligne du bilan d'un classement qui n'a pas tout classé : « classement : 2 passes non classées sur 3 (raisons) ». */
export function unclassifiedLine(label: string, missing: number, total: number, tally: FailureTally): string {
  return `${label} : ${missing} passe${missing > 1 ? 's' : ''} non classée${missing > 1 ? 's' : ''} sur ${total} (${tally.render() || 'raison inconnue'})`;
}
