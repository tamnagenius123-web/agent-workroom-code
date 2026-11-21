export function duplicateMigrationNumbers(names: string[]): Record<string, string[]>;
export const TIER_L_RULES: [RegExp, string][];
export function classifyTier(files: string[], contents?: Record<string, string>): { tier: 'D' | 'L'; reasons: string[] };
export function pathsFromNameStatus(nameStatus: string): string[];
export function diffNameStatusArgs(base: string, head?: string): string[];
export const TIER_L_NOTE: string;
export function verificationBody(body?: string): string | null;
export function verificationErrors(body?: string): string[];
export function policyErrors(input: {
  files: string[];
  body?: string;
  contents?: Record<string, string>;
}): string[];
