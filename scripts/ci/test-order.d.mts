export type FileChange = { status: string; paths: string[] };
export type LoggedCommit = { sha: string; parents: string[]; subject: string; changes: FileChange[] };
export type TestOrder = { order: 'tests-before-src' | 'src-before-tests' | 'uncertain' | 'no-code'; reasons: string[] };
export function testOrderLogArgs(base: string, head?: string): string[];
export function commitsFromLog(text: string): LoggedCommit[];
export function testOrder(commits: LoggedCommit[], opts?: { shallow?: boolean; diffFiles?: number }): TestOrder;
