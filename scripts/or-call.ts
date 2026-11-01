#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch, settlePending, type DispatchReport } from '../src/or-harness/client.ts';
import { DEFAULT_LEDGER_PATH, openLedger } from '../src/or-harness/ledger.ts';

interface Args {
  model?: string;
  project?: string;
  promptFile?: string;
  maxTokens: number;
  ledger?: string;
  dryRun: boolean;
  settlePending: boolean;
  maxTokensSet: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { maxTokens: 50, dryRun: false, settlePending: false, maxTokensSet: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run' || flag === '--settle-pending') {
      if (seen.has(flag)) throw new Error(`repeated flag: ${flag}`);
      seen.add(flag);
      if (flag === '--dry-run') out.dryRun = true;
      else out.settlePending = true;
      continue;
    }
    if (flag !== '--model' && flag !== '--project' && flag !== '--prompt-file' && flag !== '--max-tokens' && flag !== '--ledger') {
      throw new Error(`unknown flag: ${flag ?? ''}`);
    }
    if (seen.has(flag)) throw new Error(`repeated flag: ${flag}`);
    seen.add(flag);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`flag requires a value: ${flag}`);
    if (flag === '--model') out.model = value;
    else if (flag === '--project') out.project = value;
    else if (flag === '--prompt-file') out.promptFile = value;
    else if (flag === '--ledger') out.ledger = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error('--max-tokens must be a non-negative integer');
      out.maxTokens = Number(value);
      out.maxTokensSet = true;
    }
  }
  return out;
}

function printReport(report: DispatchReport): string {
  const body: Record<string, unknown> = {
    model: report.model,
    generation_id: report.generation_id,
    state: report.state,
    micro_usd: report.micro_usd,
    text: report.text.slice(0, 200),
    summary: report.summary,
    reason: report.reason,
  };
  if (report.state === 'dry_run') {
    body.estimate_micro_usd = report.estimate_micro_usd;
    body.reserve_micro_usd = report.reserve_micro_usd;
    body.reservation_ok = report.reservation_ok;
    body.run_id = report.run_id;
    body.attempt_id = report.attempt_id;
  }
  return JSON.stringify(body);
}

function assertSettlePendingOnly(args: Args): void {
  if (args.model || args.project || args.promptFile || args.dryRun || args.maxTokensSet) {
    throw new Error('usage: --settle-pending [--ledger path]');
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.settlePending) {
    assertSettlePendingOnly(args);
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
    const apiKey = process.env.OPENROUTER_API_KEY;
    const ledger = openLedger(args.ledger ?? DEFAULT_LEDGER_PATH);
    // /generation lookups only. settlePending refuses chat completions.
    const report = await settlePending({ ledger, apiKey });
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.still_pending > 0 ? 3 : 0;
    return;
  }
  if (!args.model || !args.project || !args.promptFile) {
    throw new Error('usage: --model <id> --project <key> --prompt-file <path> [--max-tokens 50] [--ledger path] [--dry-run] | --settle-pending [--ledger path]');
  }
  const prompt = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(args.promptFile));
  if (!args.dryRun && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const ledgerPath = args.ledger ?? DEFAULT_LEDGER_PATH;
  const ledger = args.dryRun && !args.ledger ? undefined : openLedger(ledgerPath);
  if (!args.dryRun) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    const report = await dispatch({
      model: args.model,
      project: args.project,
      prompt,
      maxTokens: args.maxTokens,
      ledger,
      apiKey,
    });
    process.stdout.write(printReport(report) + '\n');
    if (report.state === 'denied') process.exitCode = 2;
    else if (report.state === 'pending_actual') process.exitCode = 3;
    return;
  }
  const report = await dispatch({
    model: args.model,
    project: args.project,
    prompt,
    maxTokens: args.maxTokens,
    ledger,
    dryRun: true,
  });
  process.stdout.write(printReport(report) + '\n');
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'dispatch failed';
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
    process.exitCode = 1;
  });
}
