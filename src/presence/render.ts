import type { PresenceReport } from './types.ts';

const cell = (v: string | null): string => (v === null ? '—' : v.replace(/\|/g, '\\|'));

/** Markdown rendering. Carries the same basis stamp as the JSON envelope:
 *  activity evidence only, explicitly NOT wake proof. */
export function renderPresenceMarkdown(report: PresenceReport): string {
  const lines: string[] = [];
  lines.push('# Presence / activity projection');
  lines.push('');
  lines.push(`basis: ${report.basis} · not_wake_proof: ${report.not_wake_proof}`);
  lines.push('> NOT wake proof — activity observations only. A row here does not show that an agent woke, started a host, claimed work, or caused an effect.');
  lines.push('');
  lines.push(`as_of: ${report.as_of ?? '—'} · thresholds: active ≤ ${report.thresholds.active_within_ms} ms, recent ≤ ${report.thresholds.recent_within_ms} ms`);
  lines.push('');
  lines.push('| agent_id | class | last_activity_at | last_message_id | last_delivery_at | messages | deliveries | clock_skew |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const a of report.agents) {
    lines.push(`| ${cell(a.agent_id)} | ${a.classification} | ${cell(a.last_activity_at)} | ${cell(a.last_message_id)} | ${cell(a.last_delivery_at)} | ${a.counts.messages} | ${a.counts.deliveries} | ${a.clock_skew} |`);
  }
  lines.push('');
  const o = report.omitted;
  lines.push(`inputs: messages ${report.inputs.messages_used}/${report.inputs.messages_seen} used, deliveries ${report.inputs.deliveries_used}/${report.inputs.deliveries_seen} used`);
  lines.push(`omitted: messages_invalid=${o.messages_invalid}, delivery_lines_malformed=${o.delivery_lines_malformed}, deliveries_invalid=${o.deliveries_invalid}, deliveries_unattributed=${o.deliveries_unattributed}, duplicate_deliveries=${o.duplicate_deliveries}, clamped_timestamps=${o.clamped_timestamps}`);
  if (report.clock_skew_detected) lines.push('clock_skew_detected: true — future timestamps were clamped to as_of, never trusted.');
  return lines.join('\n') + '\n';
}
