export interface VerdictPorte { code: 0 | 1; at: string }
export function noterVerdict(depot: string, sha: string, code: 0 | 1, at: Date): void;
export function verdictPour(depot: string, sha: string): VerdictPorte | null;
