export const STALE: RegExp[];
export const ALLOW: RegExp[];
export function staleHits(files: string[], read: (f: string) => string): string[];
