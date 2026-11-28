export interface Regenere { command: string; dir: string }
export function lireRegeneration(valeur: unknown, fichier: string): Regenere[];
export interface SessionRun { parentClaudeMd: boolean; userClaudeMd: boolean; keepAgents: string[]; keepSkills: string[]; keepMcpServers: string[] }
export function lireSessionRun(valeur: unknown, fichier: string): SessionRun;
