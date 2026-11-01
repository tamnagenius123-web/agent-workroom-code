// Check-in brief → markdown. Rendering is a pure projection of the brief:
// it adds no information and drops none — every section, reason and source
// ref present in the brief JSON appears in the markdown.

import type { CheckinBrief } from './types.ts';

function fmtAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ${min % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function shortSha(sha: string | null): string {
  return sha === null ? '(no sha)' : sha.slice(0, 8);
}

export function renderMarkdown(brief: CheckinBrief): string {
  const h = brief.header;
  const lines: string[] = [];
  lines.push(`# Check-in brief — ${h.room ?? '(unknown room)'}`);
  lines.push('');
  lines.push(`- Status: **${h.status}**`);
  lines.push(`- Snapshot built at: ${h.builtAt ?? '(unknown)'} (age ${fmtAge(h.ageMs)})`);
  lines.push(
    `- Room watermark: ${h.watermark.lastMessageId ?? '(none)'} @ ${h.watermark.lastMessageAt ?? '(none)'} · ${h.watermark.messageCount ?? '?'} messages · main ${shortSha(h.watermark.mainSha)}`,
  );
  if (h.partialReasons.length > 0) {
    lines.push('- Partial reasons:');
    for (const r of h.partialReasons) lines.push(`  - \`${r.code}\` — ${r.detail}`);
  }
  lines.push(
    `- Summary: ${brief.summary.openPrs} open PRs · ${brief.summary.awaitingReviews} awaiting review (${brief.summary.awaitingMe} awaiting me) · ${brief.summary.satisfied} satisfied · ${brief.summary.blocked} blocked · ${brief.summary.holds} on hold · ${brief.summary.conflicts} conflicts`,
  );
  lines.push('');

  lines.push('## Open claims — UNKNOWN');
  lines.push('');
  lines.push(`> ${brief.claims.reason}`);
  lines.push('');

  lines.push(`## Blocked (${brief.blocked.length})`);
  lines.push('');
  if (brief.blocked.length === 0) lines.push('(none in snapshot)');
  for (const g of brief.blocked) {
    const pr = g.pr !== null ? ` · PR #${g.pr}` : '';
    lines.push(
      `- [${g.kind}] ${g.excerpt} (${g.source} ${g.ref}, raised by ${g.raisedBy ?? '(unknown)'}, at ${g.at ?? '(unknown)'}${pr}; waiting on: unknown — not carried by the snapshot)`,
    );
  }
  lines.push('');

  lines.push(`## Reviews awaiting (${brief.reviews.awaiting.length} · ${brief.reviews.satisfiedCount} satisfied)`);
  lines.push('');
  if (brief.reviews.awaiting.length === 0) lines.push('(none)');
  for (const r of brief.reviews.awaiting) {
    const flags = r.flags.length > 0 ? ` · flags: ${r.flags.join(', ')}` : '';
    const me = r.awaitingMe ? ' · awaiting me' : '';
    lines.push(
      `- #${r.pr} ${r.title} — ${r.state}${flags}${me} · head ${r.headRefName} @ ${shortSha(r.headRefOid)} · author ${r.author ?? '(unknown)'} · ${r.url}`,
    );
    if (r.verdicts.length === 0) {
      lines.push('  - verdict history: none');
    }
    for (const v of r.verdicts) {
      lines.push(
        `  - ${v.verdict} by ${v.actor} at ${v.at} @ ${shortSha(v.sha)} — msg ${v.messageId}${v.localCi ? ' [local CI cited]' : ''}`,
      );
    }
  }
  lines.push('');

  lines.push(`## Unknown / stale (${brief.unknown.length})`);
  lines.push('');
  if (brief.unknown.length === 0) lines.push('(none)');
  for (const u of brief.unknown) {
    const refs = u.refs.length > 0 ? ` [refs: ${u.refs.join(', ')}]` : '';
    lines.push(`- ${u.kind}${u.pr !== null ? ` PR #${u.pr}` : ''} — ${u.detail}${refs}`);
  }
  lines.push('');
  return lines.join('\n');
}
