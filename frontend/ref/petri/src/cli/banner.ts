/**
 * The trust banner and the mode banner of SPEC.md §8.9.
 *
 * The banner goes to stderr, so `--json` keeps stdout machine-readable.
 * There is no flag to hide it. `--quiet` never suppresses it.
 *
 * Nothing here emits ANSI colour. The output must read correctly in a plain
 * terminal, in a log file and in a screenshot.
 */
import type { PetriConfig } from '../config.js';
import type { Mode, NodeStatus } from '../core/schema.js';
import { logPath } from '../store/paths.js';

export type TrustLabel = 'hcs' | 'local-unverified';

/** The honest one-word trust label that every status line and export carries. */
export function trustLabel(cfg: Pick<PetriConfig, 'ledger'>): TrustLabel {
  return cfg.ledger === 'hcs' ? 'hcs' : 'local-unverified';
}

/** The one-line summary. Every command prints this, whatever else it prints. */
export function bannerLine(cfg: PetriConfig): string {
  const model = cfg.mode === 'live' ? 'live (calls claude-sonnet-5)' : 'replay (no model call)';
  const ledger =
    cfg.ledger === 'hcs' && cfg.hedera
      ? `hedera topic ${cfg.hedera.topicId} (${cfg.hedera.network})`
      : 'local-log (this machine only)';
  return `PETRI  mode ${model}  |  trust ${ledger}`;
}

/** The `ledger` block of §8.9, verbatim. */
export function trustBanner(cfg: PetriConfig, root: string): string {
  if (cfg.ledger === 'hcs' && cfg.hedera) {
    return [
      `TRUST  hedera topic ${cfg.hedera.topicId} (${cfg.hedera.network})  —  PUBLIC`,
      '  Every message is public. Read them with no key and no account:',
      `    ${cfg.hedera.mirrorRest[0]}/api/v1/topics/${cfg.hedera.topicId}/messages`,
      '  `petri tree` and `petri status` derive every status from that log alone.',
      '  A topic proves order, time and non-deletion. It does not prove that two keys',
      '  are two people, and it does not prove a verifier ran the benchmark.',
    ].join('\n');
  }
  return [
    `TRUST  local log ${logPath(root)}  —  UNVERIFIED`,
    '  This log is on this machine only. It proves nothing about independence.',
    '  One person can hold every key in it. The file can be edited or deleted.',
    '  Only a Hedera topic proves order, time and non-deletion to a stranger.',
    '  Run `petri topic create` to publish to a real topic.',
  ].join('\n');
}

/** The `mode` block of §8.9. `live` gets an equally plain one. */
export function modeBanner(mode: Mode): string {
  if (mode === 'replay') {
    return [
      'MODE   replay  —  this is NOT a new measurement',
      '  Replay re-runs recorded harness outputs through the real sandbox.',
      '  The tests genuinely execute. The harness does not call a model.',
      '  A replay number can never be compared against a live number.',
    ].join('\n');
  }
  return [
    'MODE   live  —  the harness calls claude-sonnet-5 for real',
    '  Every score costs tokens and depends on the provider on the day.',
    '  Two honest runs can differ. The median over N runs reduces that, not removes it.',
    '  A live number can never be compared against a replay number.',
  ].join('\n');
}

/** Print the full banner to stderr. Call it before every result. */
export function printBanner(cfg: PetriConfig, root: string): void {
  process.stderr.write(`${bannerLine(cfg)}\n`);
  process.stderr.write(`${trustBanner(cfg, root)}\n`);
  process.stderr.write(`${modeBanner(cfg.mode)}\n\n`);
}

/**
 * The banner for a command that runs before `.petri/config.json` exists, so it
 * has a ledger and a mode but no config object to read them from.
 */
export function printBareBanner(ledger: 'hcs' | 'local', mode: Mode, detail: string): void {
  const model = mode === 'live' ? 'live (calls claude-sonnet-5)' : 'replay (no model call)';
  process.stderr.write(`PETRI  mode ${model}  |  trust ${detail}\n`);
  if (ledger === 'local') {
    process.stderr.write(
      'TRUST  local  —  UNVERIFIED. This log is on this machine only.\n' +
        '  It proves nothing about independence, time or non-deletion.\n',
    );
  } else {
    process.stderr.write(
      `TRUST  hedera ${detail}  —  PUBLIC\n` +
        '  A topic proves order, time and non-deletion. It does not prove that two\n' +
        '  keys are two people, and it does not prove a verifier ran the benchmark.\n',
    );
  }
  process.stderr.write(`${modeBanner(mode)}\n\n`);
}

export const shortId = (id: string): string => (id === 'root' ? 'root' : id.slice(0, 8));

export const fmtBp = (bp: number): string => `${bp >= 0 ? '+' : ''}${bp}bp`;

/** Render a delta for a status line. Contested nodes show both ends. */
export function fmtDelta(deltaBp: number | null, spread: readonly number[] = []): string {
  if (deltaBp !== null) return fmtBp(deltaBp);
  if (spread.length >= 2) {
    const hi = Math.max(...spread);
    const lo = Math.min(...spread);
    return `${fmtBp(hi)}/${lo}bp`;
  }
  return '-';
}

/**
 * Why one stored report did not count. The label is short enough for a status
 * line. The sentence is the one `petri status --why` prints.
 */
export type IgnoredKind = 'duplicate key' | 'self-report' | 'invalid report' | 'policy';

export interface IgnoredVerification {
  pub: string;
  kind: IgnoredKind;
  why: string;
}

/**
 * The verifier count a reader may trust.
 *
 * `counted` is the set the ACCEPTANCE RULE used, never the number of report
 * files on disk. The two differ whenever a key verifies twice, whenever the
 * author signs a report of their own node, and whenever policy drops a report.
 * Printing the raw file count inflates the evidence, so nothing here exposes it.
 * `src/cli/tree.ts` derives this from the node and its verdict.
 */
export interface VerifierTally {
  counted: number;
  ignored: readonly IgnoredVerification[];
}

/** "1 ignored (duplicate key)". Empty when every stored report counted. */
export function ignoredPhrase(t: VerifierTally): string {
  if (t.ignored.length === 0) return '';
  const counts = new Map<IgnoredKind, number>();
  for (const i of t.ignored) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => (n === 1 ? kind : `${n} ${kind}`));
  return `${t.ignored.length} ignored (${parts.join(', ')})`;
}

/** "2 counted, 1 ignored (duplicate key)". Never a bare, inflated number. */
export function verifiersPhrase(t: VerifierTally): string {
  const tail = ignoredPhrase(t);
  return tail === '' ? `${t.counted} counted` : `${t.counted} counted, ${tail}`;
}

export interface StatusLineInput {
  id: string;
  status: NodeStatus;
  deltaBp: number | null;
  deltas?: readonly number[];
  /** The counted set, and every report that did not count. NEVER a file count. */
  verifiers: VerifierTally;
  mode: Mode;
  trust: TrustLabel;
}

/**
 * The status line of §8.9. Every line carries the mode and the trust label, so a
 * screenshot cannot hide which of the four states produced the number.
 *
 * The verifier field carries the counted set, so the number on the line and the
 * number in the verdict can never disagree.
 */
export function statusLine(v: StatusLineInput): string {
  const delta = fmtDelta(v.deltaBp, v.deltas ?? []);
  return (
    `${shortId(v.id)}  ${v.status.padEnd(10)} delta ${delta.padEnd(13)}` +
    ` verifiers ${verifiersPhrase(v.verifiers).padEnd(11)}  mode ${v.mode.padEnd(6)}` +
    `  trust ${v.trust}`
  );
}
