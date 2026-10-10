# Petri engine

Petri is a version tree for AI agent harnesses. Every node carries a plain-English
hypothesis, a measured score, and signatures from keys that re-ran the measurement.
Rejected nodes are never deleted.

The web app that shows this tree lives at the repository root. This directory holds
the engine: the CLI, the benchmark, the harness under evolution, and the recorded tree.

---

## The problem

**1. Nobody measures.** Teams change a prompt, a retry rule or a retrieval order, then
say the agent "feels better". There is no number, no baseline and no repeat count.

**2. Failures stay private.** A dead end lives in one person's terminal history. The
next engineer tries the same idea, and the team pays for the same tokens twice.

**3. Nobody can check a claim.** A reported gain cannot be re-run, because the harness
and the measurement are not published.

---

## How a node is decided

A node names its parent, its harness snapshot, the benchmark and a hypothesis. Its id is
the SHA-256 of that manifest, so the same experiment gives the same id on any machine.

1. A verifier re-runs **both sides**, the parent and the candidate.
2. Each side runs 5 times. The **median** counts. An even run count is refused.
3. The author's key cannot verify its own node. Two reports from one key count as one.
4. A node is `accepted` when 2 verifications from distinct keys each report at least
   +1000 basis points. At or below -1000 it is a `REGRESSION`. Anything between is
   rejected as a tie, `WITHIN_NOISE`. Rejected nodes stay in the tree.

The rule is a pure function in `src/policy/acceptance.ts`.

---

## Why this is evolution

| Evolution | What the code does |
|---|---|
| **Variation** | A node changes at most 2 files and 120 lines of its parent harness. `src/evolve/guards.ts` refuses a bigger patch. `harness/contract.ts` is frozen. |
| **Inheritance** | A node starts from its parent's harness snapshot, not from the working tree. |
| **Selection** | `src/policy/acceptance.ts` reads the signed deltas and returns the status. |

Nature discards failures. Petri keeps them: `petri dead-ends` prints every rejected node
with its hypothesis and reason.

---

## The recorded tree

`.petri/` holds 16 nodes: 3 accepted, 2 rejected and 11 pending.

| Node | Status | What it tried |
|---|---|---|
| `0a54718a` | pending | The baseline: single-shot prompt, no retry |
| `ecc7cdb0` | accepted, +7000bp | Full symbol signatures and one worked example |
| `872aaa3d` | rejected, -7000bp | Removing the signatures and the example again |
| `ea3b7532` | accepted, +7000bp | Restoring them, one step after the rejected node |
| `f07e0c55` | rejected, -7000bp | Trimming the prompt again to save tokens |
| `92dc9c49` | accepted, +7000bp | Restoring the signatures after the trim |
| `ec1d39e6` | pending, 1 of 2 keys | An independent re-test of signatures and example |
| `e1adae18` | pending, 1 of 2 keys | A short prompt without the reply-shape block |
| `2e7f6b5b` | pending, not scored | Stating every prompt rule as a positive directive |
| 7 pending nodes | pending | Changes stopped by a guard or the typecheck |

This is the start of the real `petri digest` output for this tree:

```
# PETRI DIGEST  ledger 16 nodes  digest-hash a1691051
bench petri-bench-v1 5ec2e9b8 | 20 tasks | unit tests only | N=5 runs | MEDIAN
mode REPLAY (deterministic, no API key). REPLAY never compares against LIVE.
ledger LOCAL — UNVERIFIED. See the trust banner.
totals: 3 accepted | 2 rejected | 11 pending | 0 contested
head n014 9500bp | root n000 0bp | lift +9500bp over 5 accepted steps
```

The digest is what an agent reads before it proposes a node. It lists what won, what
lost and why, and which areas nobody has tried.

---

## Quickstart

No API key and no Hedera account are needed for these steps.

```bash
pnpm install
pnpm typecheck                  # no output means it passed
pnpm test                       # 102 tests
pnpm petri id create --label me # your own key. The repo never ships a private key.
pnpm petri tree                 # the whole tree, rejected branches included
pnpm petri digest               # what an agent reads before proposing
pnpm petri dead-ends            # every rejected node with its reason
pnpm petri show ecc7cdb0        # one node in full
pnpm petri verify ecc7cdb0      # re-run both sides 5 times and sign the result
pnpm petri evolve --dry-run     # the digest and the exact prompt a model would get
```

Registered commands: `init config id topic snapshot propose submit show tree tips
dead-ends lineage diff evolve verify status publish digest areas export fsck
anchor`.

---

## Add a node

```bash
MODE=replay ./demo/positive-prompt.sh
```

The script proposes a change under `ecc7cdb0`, writes the new `prompt.ts` and submits it.
In replay mode the change passes the guards and the typecheck, and is recorded as
`not-scored`, because replay holds recorded answers for 2 harness versions only.

To score a new change for real, run it live. This needs `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=... ./demo/positive-prompt.sh
```

The live path has not been run on this tree yet.

---

## What the sandbox enforces

- The harness runs in a child process under Node `--permission`, with one read grant
  over a directory that holds the prompt and the harness only. See `bench/src/harnessJail.ts`.
- The solution runs in a second child process. The test source is never written to disk.
  See `bench/src/sandbox.ts`.
- `petri verify` refuses a node that was never scored, and exits 4.

---

## Hedera anchor and World ID

`petri anchor` copies every line of `.petri/log.jsonl` and `.petri/world-checks.jsonl`
to a Hedera Consensus Service topic, as the exact bytes and in order. The local log
stays the source of the tree. See `src/consensus/anchor.ts`.

```bash
export HEDERA_OPERATOR_ID=0.0.12345 HEDERA_OPERATOR_KEY=302e...
pnpm petri anchor create --network testnet   # a topic with no admin key and no submit key
pnpm petri anchor push                       # send every record not on the topic yet
pnpm petri anchor status                     # counts, mirror URL and HashScan URL
```

When a topic is set up, `verify`, `submit`, `evolve` and `publish` send their new records
by themselves. A receipt for each line goes into `.petri/anchors.jsonl`. A line that
changes after it reached Hedera is reported, and the push stops. The anchor is tested
with a fake topic. It has not been run against a real topic on this tree yet.

`petri verify` runs a World ID check after it signs the report. It is off unless
`PETRI_WORLD_ID=1`. It looks up `PETRI_WORLD_ADDRESS` in World AgentBook on World Chain
and records the result in `.petri/world-checks.jsonl`. See `src/trust/world.ts`. The
check does not link the wallet to the signing key yet, and it does not change acceptance.

---

## What this does not prove

- **A verifier can sign without running the benchmark.** Nothing in this build compares
  result hashes across verifiers.
- **A local log proves nothing about independence.** One person can create many keys.
  Distinct keys are not distinct people. A Hedera topic gives shared order and a
  timestamp, and does not change this.
- **Replay covers 2 harness versions.** A new harness needs a live run to get a score.
  `--allow-graded` does not help yet: all 20 `bench/tasks/*/answers/` directories are empty.
- **The benchmark is 20 tasks.** A gain here may not carry over to other work.
- **Live mode is not deterministic.** A median over 5 runs reduces sampling noise. It
  does not remove it.

---

## Repository map

| Path | Holds |
|---|---|
| `SPEC.md` | The binding contract for hashing, signing, the acceptance rule and the CLI |
| `src/core/` | Canonical JSON, SHA-256, content ids, shared schemas |
| `src/trust/` | ed25519 identity, signed envelopes, the verification report |
| `src/consensus/` | The local hash-chained log, the Hedera topic client, the replay reducer |
| `src/policy/acceptance.ts` | The acceptance rule |
| `src/store/` | Everything under `.petri/` |
| `src/evolve/` | Guards, the diff, the scratch typecheck, candidate measurement |
| `src/flatten/` | The digest model and renderer |
| `src/cli/` | The CLI entry point and every command |
| `bench/` | 20 tasks, the sandbox, the runner, the median, the recorded fixtures |
| `harness/` | The harness files under evolution. `contract.ts` is frozen |
| `demo/` | The positive-prompt demo change and its script |
| `test/` | 102 tests |
