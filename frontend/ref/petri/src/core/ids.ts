/**
 * Content addressing. See SPEC.md section 3.
 *
 * Four id makers, one hash:
 *   content id  contentId(value)
 *   node id     contentId(manifest)  where manifest.protocol === 'petri/node/1'
 *   bench id    contentId(spec)      where spec.protocol === 'petri/bench/1'
 *   harness id  sha256Hex(harnessDigestInput(snapshot))
 *
 * Domains are separated by the in-band `protocol` field, not by a hash prefix,
 * so anybody can recompute an id from the stored bytes with one function.
 * The hash prefix survives in signing only. See src/trust/envelope.ts.
 *
 * An id depends ONLY on what the experiment IS. It never depends on where or
 * when the experiment ran. Section 6.4a of SPEC.md splits every field of a
 * NodeDetail into IDENTITY and OBSERVATION, and `detailToCanon` below is the
 * one place that split is applied.
 */
import { byteCompare, contentId, sha256Hex, type Canon } from './canonical.js';
import { frame, utf8 } from './bytes.js';
import type {
  BenchSpec, ClaimedRun, DetailObservation, HarnessSnapshot, MechanicalResult,
  NodeDetail, NodeManifest, Provenance,
} from './schema.js';

export const HARNESS_DOMAIN = 'petri.harness.v1\n';

/**
 * Widen a Petri record to the canonical value type.
 *
 * Every record in Petri is a plain object of strings, integers, booleans and
 * arrays, which is exactly Canon. canonicalJson re-checks every value at run
 * time, so this cast can never hide a bad shape.
 */
export const toCanon = (value: unknown): Canon => value as Canon;

/**
 * Grammar. Every literal is ASCII.
 *
 *   input = "petri.harness.v1\n" "count " N "\n" entry*
 *   entry = "path " len "\n" pathUtf8    "\n"
 *           "data " len "\n" contentUtf8 "\n"
 *
 * N and len are decimal. No sign, no leading zeros, no padding.
 * Entries appear in UTF-8 byte order of the path.
 * The insertion order of the input object does not matter.
 *
 * A second serialiser exists because file content is arbitrary text. The length
 * prefix removes an attack canonical JSON cannot: without it, { "ab": "c" } and
 * { "a": "bc" } can serialise to the same bytes, so an author could hide one
 * harness behind another's hash. It hashes file trees and nothing else.
 */
export function harnessDigestInput(snapshot: HarnessSnapshot): Buffer {
  const paths = Object.keys(snapshot).sort(byteCompare);
  const parts: Buffer[] = [utf8(HARNESS_DOMAIN), utf8(`count ${paths.length}\n`)];
  for (const p of paths) {
    parts.push(frame('path', utf8(p)));
    parts.push(frame('data', utf8(snapshot[p]!)));
  }
  return Buffer.concat(parts);
}

export const harnessId = (snapshot: HarnessSnapshot): string =>
  sha256Hex(harnessDigestInput(snapshot));

/** The harness id of the empty snapshot. It is the parent baseline of every root. */
export const EMPTY_HARNESS_ID =
  '5894095975556df34aedf9a9be1228f959515821141de45e140f46890fe83a59';

/** The node id. Nothing else makes one. */
export const nodeIdOf = (manifest: NodeManifest): string => contentId(toCanon(manifest));

/** The bench id. */
export const benchIdOf = (spec: BenchSpec): string => contentId(toCanon(spec));

/** The content id of the test source of one task. Section 10.3. */
export const testsIdOf = (source: string): string =>
  contentId({ protocol: 'petri/tests/1', source });

/* ------------------------------------------------------------------ *
 * Identity, or observation? SPEC.md section 6.4a.
 *
 * A node id must depend ONLY on what the experiment IS, never on where or when
 * it ran. The three projections below strip every field that answers "where"
 * or "when" from the value that is hashed. The stripped fields stay in the
 * stored record and are read back with `detailObservation`.
 * ------------------------------------------------------------------ */

/**
 * One TypeScript diagnostic, reduced to a stable form.
 *
 * A compiler prints `<path>(<line>,<col>): error TS####: <message>`. The path
 * carries the absolute scratch workspace, so everything before `harness/` is
 * cut. The message text is cut with it, because it is prose that a compiler
 * release may reword.
 *
 * The prefix is `.*?` and not `\S*?`, because a home directory may hold a space.
 * A path that a space made unmatchable would drop a whole diagnostic, and two
 * machines would then disagree about a node id again.
 */
const DIAGNOSTIC_RE = /^.*?(harness[\\/][^\s:()]+)\((\d+),(\d+)\)\s*:\s*error\s+(TS\d+)/;
/** A diagnostic with no file, such as `error TS18003: No inputs were found`. */
const BARE_DIAGNOSTIC_RE = /^error\s+(TS\d+)/;

/**
 * The ordered list of compiler diagnostics inside a tool output.
 *
 * This is the whole of `MechanicalResult.evidence` that a node id sees. Every
 * other line is observation: the tool banner, the absolute tsconfig path, the
 * "no compiler could be started" list, the clip marker. Order is the order the
 * compiler printed, which is file order and is therefore stable.
 */
export function diagnosticsOf(evidence: string): string[] {
  const out: string[] = [];
  for (const raw of evidence.split('\n')) {
    const line = raw.trim();
    const located = DIAGNOSTIC_RE.exec(line);
    if (located !== null) {
      out.push(`${located[1]!.replace(/\\/g, '/')}(${located[2]!},${located[3]!}) ${located[4]!}`);
      continue;
    }
    const bare = BARE_DIAGNOSTIC_RE.exec(line);
    if (bare !== null) out.push(bare[1]!);
  }
  return out;
}

/** The measurement of one claimed run. `wallMs` is dropped. */
export const claimedRunIdentity = (run: ClaimedRun): Canon =>
  ({ passed: run.passed, scoreBp: run.scoreBp, tokens: run.tokens });

/** Who proposed the change, with which seed. `promptHash` and `digestHash` are dropped. */
export const provenanceIdentity = (p: Provenance): Canon =>
  ({ model: p.model, seed: p.seed, source: p.source });

/** The machine verdict, plus its diagnostics. `command` and `exitCode` are dropped. */
export const mechanicalIdentity = (m: MechanicalResult): Canon =>
  ({ cls: m.cls, diagnostics: diagnosticsOf(m.evidence) });

/**
 * The IDENTITY of a NodeDetail, as a canonical value. `node` is left as the
 * caller set it.
 *
 * Three rules apply.
 *
 * 1. A null `whyNotUntested` is dropped, because canonical JSON forbids null
 *    and absent means absent (section 13.2).
 * 2. Every observation field is dropped (section 6.4a). Wall time, the tool
 *    command line, its exit code, the prompt hash and the digest hash never
 *    reach a hash, and `evidence` reaches it only as its diagnostics.
 * 3. Nothing else is touched.
 *
 * THIS IS THE ONLY PLACE A NodeDetail IS TURNED INTO A HASHED VALUE. A second
 * copy of these rules would let two machines hash one detail to two ids, and every
 * signature over that node would then fail on one of them.
 *
 * The returned object names every key of NodeDetail, so a field added later
 * fails the build here until an author decides which half it belongs to.
 */
export function detailToCanon(detail: NodeDetail): Canon {
  const proposal: Record<string, unknown> = { ...detail.proposal };
  if (proposal['whyNotUntested'] === null) delete proposal['whyNotUntested'];

  const identity: { [K in keyof NodeDetail]: Canon } = {
    protocol: detail.protocol,
    node: detail.node,
    mode: detail.mode,
    proposal: toCanon(proposal),
    derivedAreas: [...detail.derivedAreas],
    areaMismatch: detail.areaMismatch,
    claimedRuns: detail.claimedRuns.map(claimedRunIdentity),
    claimedMedianBp: detail.claimedMedianBp,
    parentHarness: detail.parentHarness,
    provenance: provenanceIdentity(detail.provenance),
    mechanical: mechanicalIdentity(detail.mechanical),
  };
  return toCanon(identity);
}

/**
 * The exact value a NodeDetail hashes to. Four rules apply, and `petri fsck`
 * check 5 verifies all four.
 *
 * 1. `node` is a back-reference. It is blanked before hashing (section 6.4).
 * 2. A null `whyNotUntested` is dropped (section 13.2).
 * 3. Every observation field is dropped (section 6.4a).
 * 4. Nothing else is touched.
 */
export function detailDigestInput(detail: NodeDetail): Canon {
  return detailToCanon({ ...detail, node: '' });
}

/** The content id a NodeManifest.detail field must carry. */
export const detailIdOf = (detail: NodeDetail): string => contentId(detailDigestInput(detail));

/**
 * Everything the stored detail holds that its id does not cover. Section 6.4a.
 * It is display data. Printing it is safe. Hashing it is not.
 */
export function detailObservation(detail: NodeDetail): DetailObservation {
  return {
    claimedWallMs: detail.claimedRuns.map((r) => r.wallMs),
    command: detail.mechanical.command,
    exitCode: detail.mechanical.exitCode,
    evidence: detail.mechanical.evidence,
    promptHash: detail.provenance.promptHash,
    digestHash: detail.provenance.digestHash,
  };
}
