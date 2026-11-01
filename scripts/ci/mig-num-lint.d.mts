export interface MigrationRegistryRow {
  number: string;
  unit: string;
  status: string;
}

export function parseRegistryMarkdown(markdown: string): MigrationRegistryRow[];

export function migrationNumberErrors(
  baseFiles: readonly string[],
  headFiles: readonly string[],
  rows: readonly MigrationRegistryRow[],
): string[];

export function migrationErrorsAt(
  baseRev: string,
  headRev: string,
  io: {
    lstat: (path: string) => { isSymbolicLink: () => boolean; isFile: () => boolean };
    readFile: (path: string, encoding: 'utf8') => string;
    execGit: (args: readonly string[]) => string;
    fail: (message: string) => void;
    missing?: 'skip' | 'fail';
  },
): string[];
