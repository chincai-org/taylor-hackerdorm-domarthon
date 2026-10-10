/**
 * The plain-text renderer. SPEC.md §12.3, §12.4.
 *
 * Fixed-width columns, a fixed section order, and no wasted word. The output
 * is diff-stable: the same digest always renders the same bytes.
 *
 * The header, the area map and NEVER TRIED never drop. Everything else drops
 * from the tail, one whole record at a time, until the text fits the budget.
 * A record is never cut in half, and every drop is stated in the footer.
 */

import { AREA_LIMITS, AREA_REGISTRY, type Area } from './areas.js';
import type { PetriNode } from '../core/schema.js';
import type { AreaStat, Digest, FailureCard, MotifStat, SpineRow } from './digest.js';

/** The right margin of every wrapped line. */
const WIDTH = 110;
/** Four characters to a token. Good enough to keep a budget honest. */
const CHARS_PER_TOKEN = 4;

export const fmtBp = (bp: number): string => `${bp >= 0 ? '+' : ''}${bp}bp`;

export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : String(abs);
  return n < 0 ? `-${body}` : body;
}

export const fmtTokenDelta = (n: number): string => (n >= 0 ? `+${fmtTokens(n)}` : fmtTokens(n));

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Pad to a column. A value wider than its column keeps one separating space. */
function cell(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}
function rcell(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padStart(width);
}

/** Wrap on spaces. A word longer than the width keeps its own line, whole. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [''];
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  out.push(line);
  return out;
}

/** Wrap `text` under a prefix, with every later line indented to match. */
function wrapUnder(prefix: string, text: string, width = WIDTH): string[] {
  const lines = wrapText(text, Math.max(20, width - prefix.length));
  const pad = ' '.repeat(prefix.length);
  return lines.map((l, i) => (i === 0 ? prefix + l : pad + l));
}

// ---------------------------------------------------------------------------
// The budget plan
// ---------------------------------------------------------------------------

interface Plan {
  spine: number;        // Rows kept. The root and the head always survive.
  areaDetail: number;   // Blocks kept, from the most productive area down.
  failures: number;     // Cards kept, highest ranked first.
  exhausted: number;    // Rows kept.
  mechanical: number;   // Rows kept.
  knownMotifs: boolean;
  areaNotes: boolean;
}

function fullPlan(d: Digest): Plan {
  return {
    spine: d.spineRows.length,
    areaDetail: d.areas.filter((a) => a.tried > 0).length,
    failures: d.notableFailures.length,
    exhausted: d.exhaustedMotifs.length,
    mechanical: d.mechanicalFailures.length,
    knownMotifs: true,
    areaNotes: true,
  };
}

/**
 * One step down the ladder. The order is least informative first: a patch that
 * never ran, then the motif vocabulary, then the generated notes, then area
 * detail, then the exhausted list, then failed hypotheses, then spine history.
 */
function reduce(p: Plan): Plan | null {
  if (p.mechanical > 0) return { ...p, mechanical: p.mechanical - 1 };
  if (p.knownMotifs) return { ...p, knownMotifs: false };
  if (p.areaNotes) return { ...p, areaNotes: false };
  if (p.areaDetail > 0) return { ...p, areaDetail: p.areaDetail - 1 };
  if (p.exhausted > 0) return { ...p, exhausted: p.exhausted - 1 };
  if (p.failures > 0) return { ...p, failures: p.failures - 1 };
  if (p.spine > 2) return { ...p, spine: p.spine - 1 };
  return null;
}

// ---------------------------------------------------------------------------
// renderDigest
// ---------------------------------------------------------------------------

export function renderDigest(d: Digest, maxTokens = 6000): string {
  let plan = fullPlan(d);
  let text = render(d, plan);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text;
  while (estimateTokens(text) > maxTokens) {
    const next = reduce(plan);
    if (next === null) break;
    plan = next;
    text = render(d, plan);
  }
  return text;
}

function render(d: Digest, plan: Plan): string {
  const trimmed: string[] = [];
  const out: string[] = [];

  out.push(...header(d));
  out.push('', ...sectionSpine(d, plan, trimmed));
  out.push('', ...sectionAreaMap(d));

  const detail = sectionAreaDetail(d, plan, trimmed);
  if (detail.length > 0) out.push('', ...detail);

  out.push('', ...sectionNeverTried(d));

  const failures = sectionFailures(d, plan, trimmed);
  if (failures.length > 0) out.push('', ...failures);

  const exhausted = sectionExhausted(d, plan, trimmed);
  if (exhausted.length > 0) out.push('', ...exhausted);

  const mechanical = sectionMechanical(d, plan, trimmed);
  if (mechanical.length > 0) out.push('', ...mechanical);

  out.push('', ...sectionConstraints(d, plan, trimmed));

  if (trimmed.length > 0) out.push('', `-- trimmed to fit the token budget: ${trimmed.join('; ')} --`);
  return `${out.join('\n')}\n`;
}

const label = (d: Digest, nodeId: string): string =>
  d.labels[nodeId] ?? (nodeId === '' ? '-' : nodeId.slice(0, 8));

// --- header -----------------------------------------------------------------

function header(d: Digest): string[] {
  const t = d.totals;
  const lines = [
    `# PETRI DIGEST  ledger ${t.nodes} nodes  digest-hash ${d.digestHash}`,
    `bench ${d.benchName} ${d.bench.slice(0, 8)} | ${d.taskCount} tasks | unit tests only `
      + `| N=${d.runs} runs | MEDIAN`,
    d.mode === 'replay'
      ? 'mode REPLAY (deterministic, no API key). REPLAY never compares against LIVE.'
      : 'mode LIVE (real model calls). LIVE never compares against REPLAY.',
    d.ledger === 'local'
      ? 'ledger LOCAL — UNVERIFIED. See the trust banner.'
      : 'ledger HCS — PUBLIC. Anyone can rebuild this tree from the topic.',
    `totals: ${t.accepted} accepted | ${t.rejected} rejected | ${t.pending} pending `
      + `| ${t.contested} contested`,
  ];

  if (d.head.nodeId === '') {
    lines.push('head none accepted yet | the tree has no verified baseline');
  } else {
    const steps = Math.max(0, d.spineRows.length - 1);
    lines.push(`head ${label(d, d.head.nodeId)} ${d.head.medianBp}bp `
      + `| root ${label(d, d.root.nodeId)} ${d.root.medianBp}bp `
      + `| lift ${fmtBp(d.head.medianBp - d.root.medianBp)} over ${steps} accepted steps`);
  }

  if (d.excludedByMode > 0) {
    const other = d.mode === 'replay' ? 'LIVE' : 'REPLAY';
    lines.push(`NOTE ${d.excludedByMode} node(s) measured in ${other} are excluded. `
      + `A ${d.mode.toUpperCase()} digest never mixes modes.`);
  }
  return lines;
}

// --- 1. accepted spine ------------------------------------------------------

const SPINE_PREFIX =
  cell('id', 6) + cell('area', 10) + cell('motif', 24)
  + rcell('score', 6) + '  ' + rcell('delta', 7) + '  ' + rcell('tok/task', 8) + '  ';

function sectionSpine(d: Digest, plan: Plan, trimmed: string[]): string[] {
  const out = ['## 1. ACCEPTED SPINE'];
  if (d.spineRows.length === 0) {
    out.push('none. No node has two independent verifications at or above the margin yet.');
    return out;
  }

  const kept = keepSpine(d.spineRows, plan.spine);
  const dropped = d.spineRows.length - kept.length;
  out.push(`${SPINE_PREFIX}hypothesis`);
  for (const row of kept) out.push(...spineRow(d, row));
  if (dropped > 0) {
    out.push(`… ${dropped} middle step(s) hidden`);
    trimmed.push(`${dropped} spine step(s)`);
  }
  return out;
}

/** Keep the root, the head, and the largest wins in between. */
function keepSpine(rows: SpineRow[], keep: number): SpineRow[] {
  if (keep >= rows.length || rows.length <= 2) return rows;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return rows;
  const middle = rows.slice(1, -1)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Math.abs(b.r.deltaBp ?? 0) - Math.abs(a.r.deltaBp ?? 0) || a.i - b.i)
    .slice(0, Math.max(0, keep - 2))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.r);
  return [first, ...middle, last];
}

function spineRow(d: Digest, row: SpineRow): string[] {
  const prefix =
    cell(label(d, row.nodeId), 6)
    + cell(row.area, 10)
    + cell(row.motif, 24)
    + rcell(`${row.medianBp}bp`, 6) + '  '
    + rcell(row.deltaBp === null ? '-' : fmtBp(row.deltaBp), 7) + '  '
    + rcell(row.tokensPerTask === null ? '-' : fmtTokens(row.tokensPerTask), 8) + '  ';
  return wrapUnder(prefix, row.hypothesis);
}

// --- 2. area map ------------------------------------------------------------

function sectionAreaMap(d: Digest): string[] {
  const out = [
    '## 2. AREA MAP',
    cell('area', 15) + rcell('tried', 5) + rcell('acc', 5) + rcell('rej', 5)
      + rcell('pend', 6) + rcell('contest', 9) + rcell('best delta', 11) + '   '
      + cell('best node', 11) + 'verdict',
  ];
  for (const a of d.areas) {
    const bestNode = a.best !== null && a.best.accepted ? label(d, a.best.nodeId) : '-';
    out.push(
      cell(a.area, 15)
      + rcell(String(a.tried), 5) + rcell(String(a.accepted), 5) + rcell(String(a.rejected), 5)
      + rcell(String(a.pending), 6) + rcell(String(a.contested), 9)
      + rcell(a.bestDeltaBp === null ? '-' : fmtBp(a.bestDeltaBp), 11) + '   '
      + cell(bestNode, 11) + a.verdict,
    );
  }
  return out;
}

// --- 3. area detail ---------------------------------------------------------

function sectionAreaDetail(d: Digest, plan: Plan, trimmed: string[]): string[] {
  const tried = d.areas.filter((a) => a.tried > 0);
  if (tried.length === 0) return [];
  if (plan.areaDetail === 0) {
    trimmed.push(`area detail (${tried.length} areas)`);
    return [];
  }

  const kept = tried.slice(0, plan.areaDetail);
  const out = ['## 3. AREA DETAIL'];
  for (const a of kept) out.push('', ...areaBlock(d, a, plan));
  if (kept.length < tried.length) {
    const rest = tried.slice(kept.length).map((a) => a.area).join(', ');
    out.push('', `… detail hidden for: ${rest}`);
    trimmed.push(`area detail for ${rest}`);
  }
  return out;
}

function areaBlock(d: Digest, a: AreaStat, plan: Plan): string[] {
  const counts = [`${a.tried} tried`, `${a.accepted} accepted`, `${a.rejected} rejected`];
  if (a.pending > 0) counts.push(`${a.pending} pending`);
  if (a.contested > 0) counts.push(`${a.contested} contested`);
  const out = [`### ${a.area}  ${a.verdict}  ${counts.join(' / ')}`];

  out.push(...wrapUnder(`  ${cell('best', 9)}`, bestLine(d, a)));
  out.push(...wrapUnder(`  ${cell('motifs', 9)}`, a.motifs.map(motifChip).join(' | ')));
  if (plan.areaNotes) {
    for (const note of a.notes) out.push(...wrapUnder(`  ${cell('note', 9)}`, note));
  }
  const limit = AREA_LIMITS[a.area];
  if (limit !== undefined) out.push(...wrapUnder(`  ${cell('LIMIT', 9)}`, limit));
  return out;
}

function bestLine(d: Digest, a: AreaStat): string {
  if (a.best === null) return 'no verified measurement in this area yet.';
  if (a.best.accepted) {
    const cost = a.best.tokenDeltaPerTask === null || a.best.tokenDeltaPerTask === 0
      ? '' : `  (cost ${fmtTokenDelta(a.best.tokenDeltaPerTask)} tok/task)`;
    return `${label(d, a.best.nodeId)} ${fmtBp(a.best.deltaBp)}  motif ${a.best.motif}${cost}`;
  }
  return `none beat the parent. Best measured delta ${fmtBp(a.best.deltaBp)} `
    + `(${label(d, a.best.nodeId)}, ${a.best.status}, motif ${a.best.motif}).`;
}

function motifChip(m: MotifStat): string {
  let chip = `${m.motif} ${m.accepted}/${m.attempts}`;
  if (m.accepted > 0) chip += ' acc';
  else if (m.exhausted) chip += ' EXHAUSTED';
  else if (m.pending > 0) chip += ' pending';
  if (m.accepted === 0 && m.mechanical !== null) chip += ` (${m.mechanical})`;
  return chip;
}

// --- 4. never tried ---------------------------------------------------------

function sectionNeverTried(d: Digest): string[] {
  const out = ['## 4. NEVER TRIED  (no node has touched these)'];
  if (d.neverTried.length === 0) {
    out.push('none. Every area in the registry has at least one node.');
    return out;
  }
  for (const area of d.neverTried) {
    const entry = AREA_REGISTRY[area];
    out.push(...wrapUnder(cell(area, 15), entry.summary));
    if (entry.probes.length > 0) {
      out.push(...wrapUnder(`${' '.repeat(15)}probes: `, entry.probes.join(', ')));
    }
    const limit = AREA_LIMITS[area];
    if (limit !== undefined) out.push(...wrapUnder(`${' '.repeat(15)}LIMIT: `, limit));
  }
  return out;
}

// --- 5. notable failures ----------------------------------------------------

function sectionFailures(d: Digest, plan: Plan, trimmed: string[]): string[] {
  if (d.notableFailures.length === 0) return [];
  if (plan.failures === 0) {
    trimmed.push(`${d.notableFailures.length} failed hypotheses`);
    return [];
  }
  const kept = d.notableFailures.slice(0, plan.failures);
  const out = ['## 5. NOTABLE FAILURES  (hypotheses quoted verbatim)'];
  for (const card of kept) out.push('', ...failureCard(d, card));
  if (kept.length < d.notableFailures.length) {
    const dropped = d.notableFailures.length - kept.length;
    out.push('', `… ${dropped} more failed hypothes${dropped === 1 ? 'is' : 'es'} hidden`);
    trimmed.push(`${dropped} failed hypotheses`);
  }
  return out;
}

function failureCard(d: Digest, card: FailureCard): string[] {
  const tok = card.tokenDelta === null || card.tokenDelta === 0
    ? '' : `, tok ${fmtTokenDelta(card.tokenDelta)}`;
  const head = cell(label(d, card.nodeId), 6)
    + cell(`${card.area} / ${card.motif}`, 28)
    + `rejected ${card.rejection}${tok}`;

  const quoted = wrapText(card.hypothesis, WIDTH - 4);
  const body = quoted.map((line, i) => (i === 0 ? `> "${line}` : `>  ${line}`));
  const lastIndex = body.length - 1;
  const last = body[lastIndex];
  if (last !== undefined) {
    body[lastIndex] = card.hypothesisTruncated ? `${last}…" [truncated]` : `${last}"`;
  }
  return [head, ...body];
}

// --- 6. exhausted -----------------------------------------------------------

function sectionExhausted(d: Digest, plan: Plan, trimmed: string[]): string[] {
  if (d.exhaustedMotifs.length === 0) return [];
  if (plan.exhausted === 0) {
    trimmed.push(`${d.exhaustedMotifs.length} exhausted motifs`);
    return [];
  }
  const kept = d.exhaustedMotifs.slice(0, plan.exhausted);
  const out = [
    '## 6. EXHAUSTED — DO NOT REPROPOSE',
    cell('area', 11) + cell('motif', 20) + rcell('attempts', 8)
      + rcell('accepted', 10) + rcell('best delta', 12) + '  nodes',
  ];
  for (const m of kept) {
    out.push(
      cell(m.area, 11) + cell(m.motif, 20) + rcell(String(m.attempts), 8)
      + rcell(String(m.accepted), 10) + rcell(fmtBp(m.bestDeltaBp), 12) + '  '
      + m.nodeIds.map((id) => label(d, id)).join(', '),
    );
  }
  if (kept.length < d.exhaustedMotifs.length) {
    const dropped = d.exhaustedMotifs.length - kept.length;
    out.push(`… ${dropped} more exhausted motif(s) hidden`);
    trimmed.push(`${dropped} exhausted motifs`);
  }
  out.push('To use one of these, fill `contradicts` and say what is different this time.');
  return out;
}

// --- 7. mechanical failures -------------------------------------------------

function sectionMechanical(d: Digest, plan: Plan, trimmed: string[]): string[] {
  if (d.mechanicalFailures.length === 0) return [];
  if (plan.mechanical === 0) {
    trimmed.push(`${d.mechanicalFailures.length} mechanical failures`);
    return [];
  }
  const kept = d.mechanicalFailures.slice(0, plan.mechanical);
  const out = ['## 7. MECHANICAL FAILURES  (patches that never ran)'];
  for (const f of kept) {
    out.push(...wrapUnder(cell(label(d, f.nodeId), 6) + cell(f.cls, 20), f.evidenceHead));
  }
  if (kept.length < d.mechanicalFailures.length) {
    const dropped = d.mechanicalFailures.length - kept.length;
    out.push(`… ${dropped} more mechanical failure(s) hidden`);
    trimmed.push(`${dropped} mechanical failures`);
  }
  return out;
}

// --- 8. constraints ---------------------------------------------------------

function sectionConstraints(d: Digest, plan: Plan, trimmed: string[]): string[] {
  const c = d.constraints;
  const out = ['## 8. CONSTRAINTS FOR NODE N+1'];

  const headRow = d.spineRows[d.spineRows.length - 1];
  if (headRow === undefined) {
    out.push('parent root | no accepted node yet | propose the first harness');
  } else {
    const tok = headRow.tokensPerTask === null ? '-' : `${fmtTokens(headRow.tokensPerTask)} tok/task`;
    out.push(`parent ${label(d, headRow.nodeId)} | ${headRow.medianBp}bp | ${tok} `
      + `| budget maxCalls ${c.maxCalls}, maxTokens ${c.maxTokens}`);
  }

  out.push(`at most ${c.maxFiles} files changed, at most ${c.maxChangedLines} changed lines`);
  out.push('harness/contract.ts is immutable. solve() keeps its signature.');
  out.push('imports: relative siblings inside harness/ only');
  out.push(`the win margin is ${c.minDeltaBp}bp. A smaller measured gain is rejected as WITHIN_NOISE, and kept.`);
  out.push('a SATURATED area needs whyNotUntested. An exhausted motif needs contradicts.');

  if (d.knownMotifs.length > 0) {
    if (plan.knownMotifs) {
      out.push('known motif slugs (reuse one if it fits):');
      for (const line of wrapText(d.knownMotifs.join(', '), WIDTH - 2)) out.push(`  ${line}`);
    } else {
      trimmed.push(`${d.knownMotifs.length} known motif slugs`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reverse: one node, one line
// ---------------------------------------------------------------------------

export interface SummaryOptions {
  /** The short label to print. Defaults to the first 8 characters of the id. */
  label?: string;
  /** The line length. The hypothesis is the only field that gives way. */
  width?: number;
  /** Print the hypothesis when it fits. Default true. */
  hypothesis?: boolean;
}

/**
 * One node as one line, for `petri tree` and `petri tips`.
 *
 * Every field of §8.9 is here, so a screenshot cannot hide the trust label or
 * the mode. Only the hypothesis is shortened, and it ends in an ellipsis when
 * it is.
 */
export function summariseNode(node: PetriNode, opts: SummaryOptions = {}): string {
  const width = opts.width ?? 110;
  const short = opts.label ?? node.id.slice(0, 8);
  const area = node.detail.derivedAreas[0] ?? node.detail.proposal.primaryArea;
  const motif = node.detail.proposal.motif === '' ? '-' : node.detail.proposal.motif;
  const mech = node.detail.mechanical.cls;

  const delta = node.verifiedDeltaBp !== null ? fmtBp(node.verifiedDeltaBp)
    : mech !== 'ok' ? mech
      : '-';

  const fields = cell(short, 10)
    + cell(node.status + (node.disputed ? '!' : ''), 11)
    + cell(`${area}/${motif}`, 30)
    + rcell(delta, 9) + '  '
    + cell(`v${node.verifications.length}`, 4)
    + cell(node.mode, 8)
    + cell(node.trust, 18);

  if (opts.hypothesis === false) return fields.trimEnd();

  const room = width - fields.length - 3;
  const text = node.manifest.hypothesis;
  if (room < 12) return fields.trimEnd();
  const quoted = text.length <= room ? text : `${text.slice(0, room - 1).trimEnd()}…`;
  return `${fields}"${quoted}"`;
}
