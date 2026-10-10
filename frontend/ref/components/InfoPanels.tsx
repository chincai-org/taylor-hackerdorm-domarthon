import { signedBp, tasks } from "@/lib/format";
import type { DigestResult } from "@/lib/tree";
import type { PetriExport } from "@/lib/types";
import type { PanelDef } from "./Panels";

/** The content behind each chip. Server-rendered; the chips only toggle it. */
export function buildPanels(d: PetriExport, digest: DigestResult | null): PanelDef[] {
  const total = d.bench.total;
  const head = d.nodes.find((n) => n.id === d.stats.head);
  // A win needs the full margin. On a 20-task bench, a 19/20 best cannot be beaten.
  const needBp = head ? head.detail.claimedMedianBp + d.policy.minDeltaBp : null;
  // The digest names nodes by their position in log order: n000, n001, ...
  const idKey = [...d.nodes].sort((a, b) => a.seq - b.seq)
    .map((n, i) => `n${String(i).padStart(3, "0")} = ${n.short}`).join(" · ");

  // Only a real tree has a digest. An example tree skips this panel.
  const next = digest === null ? null : (
    <div className="digest-panel">
      <p className="eyebrow">What the next agent reads</p>
      <h2>The tree, turned into instructions</h2>
      <p className="lede">
        Before an agent proposes a change, it reads this page. It shows what worked, what failed and
        why, and which areas nobody has tried. This is the real output of <code>petri digest</code>.
      </p>
      <p className="idkey">The digest numbers versions in log order: {idKey}</p>
      {digest.ok
        ? <pre className="digest">{digest.text}</pre>
        : <pre className="digest digest-error">The digest did not load:{"\n"}{digest.error}</pre>}
    </div>
  );

  const goal = (
    <div className="panel-grid">
      <div>
        <p className="eyebrow">Goal</p>
        <h2>Beat the best version by {tasks(d.policy.minDeltaBp, total).replace(` of ${total} tasks`, "")} whole tasks</h2>
        <p className="lede">
          The tree improves one agent harness. A new version is accepted only when two other keys
          re-run it and its parent, and it solves at least {d.policy.minDeltaBp}bp more of the same test.
        </p>
      </div>
      <dl className="goal-facts">
        <div><dt>Best so far</dt><dd>{head ? tasks(head.detail.claimedMedianBp, total) : "none yet"}<small>{head ? `${head.short} · ${head.detail.claimedMedianBp}bp` : ""}</small></dd></div>
        <div><dt>To beat it</dt><dd>{needBp === null ? "—" : needBp <= 10000 ? tasks(needBp, total) : "cannot be beaten"}<small>{needBp !== null && needBp > 10000 ? `needs ${tasks(needBp, total)}` : `best plus ${signedBp(d.policy.minDeltaBp)}`}</small></dd></div>
        <div><dt>The test</dt><dd>{total} tasks<small>{d.bench.name} · unit tests only</small></dd></div>
        <div><dt>Runs</dt><dd>{d.runsPerVerification} each side<small>the median counts</small></dd></div>
        <div><dt>Keys</dt><dd>{d.policy.minVerifications} needed<small>distinct keys, never the author</small></dd></div>
        <div><dt>Record</dt><dd>{d.stats.total} versions<small>{d.stats.accepted} accepted · {d.stats.rejected} rejected · {d.stats.pending} pending</small></dd></div>
      </dl>
    </div>
  );

  const rules = (
    <div>
      <p className="eyebrow">Rules</p>
      <h2>Six rules the code enforces</h2>
      <ol className="rules">
        <li><b>An author cannot verify their own version.</b> Petri refuses the key. It needs {d.policy.minVerifications} distinct keys, and two reports from one key count as one.</li>
        <li><b>Every candidate runs {d.runsPerVerification} times.</b> The median decides. An even number of runs is refused.</li>
        <li><b>Rejected versions are never deleted.</b> A failure tells the next agent where not to go.</li>
        <li><b>Every version states what its author expected.</b> A diff alone does not say why.</li>
        <li><b>The score is pass or fail on unit tests.</b> No model grades the answer, so nobody argues about the number.</li>
        <li><b>Reading and verifying the shipped tree needs no API key and no Hedera account.</b></li>
      </ol>
    </div>
  );

  const how = (
    <div className="how">
      <div>
        <p className="eyebrow">The problem</p>
        <h2>Nobody knows what makes an AI agent better</h2>
        <div className="faults">
          <div><h3>Nobody measures</h3><p>People copy harness tricks from blog posts. They rarely test them on their own agent.</p></div>
          <div><h3>Failures stay private</h3><p>A failed idea dies on one laptop. The next team pays the same tokens to learn the same thing.</p></div>
          <div><h3>Nobody can check a claim</h3><p>A score measured on your own computer proves nothing to anyone else.</p></div>
        </div>
      </div>
      <div>
        <p className="eyebrow">The mechanism</p>
        <h2>Darwin&apos;s three conditions, on code</h2>
        <table>
          <thead><tr><th scope="col">Condition</th><th scope="col">In nature</th><th scope="col">In Petri</th></tr></thead>
          <tbody>
            <tr><td>Variation</td><td>Animals differ from each other</td><td>Children of one version try different ideas</td></tr>
            <tr><td>Inheritance</td><td>A child keeps most of its parent</td><td>A child copies its parent harness, then changes at most 2 files</td></tr>
            <tr><td>Selection</td><td>The fit survive</td><td>Accepted only if two other keys measure it {d.policy.minDeltaBp}bp better</td></tr>
          </tbody>
        </table>
        <p className="punch">Nature throws failures away, so every species learns the same lesson again. Petri keeps them, with the sentence that explains why they failed.</p>
      </div>
      <div>
        <p className="eyebrow">The loop</p>
        <h2>How the tree grows</h2>
        <ol className="loop">
          <li><b>An agent reads the digest.</b> It sees what worked, what failed and why, and what nobody tried.</li>
          <li><b>It proposes one change.</b> It states what it expects, and what result would prove it wrong.</li>
          <li><b>It measures the change.</b> {total} tasks, {d.runsPerVerification} runs.</li>
          <li><b>Two other keys verify it.</b> Each re-runs the parent and the child, then signs both scores.</li>
          <li><b>The tree records the verdict.</b> Accepted or rejected, the version stays.</li>
          <li><b>The next agent reads a bigger tree.</b></li>
        </ol>
      </div>
    </div>
  );

  const limits = (
    <div>
      <p className="eyebrow">Honest limits</p>
      <h2>What this does not prove</h2>
      <ul className="limits">
        <li><b>A lazy verifier can sign without running the test.</b> Petri cannot catch this yet. It needs an evidence and dispute process.</li>
        <li><b>Two distinct keys are not two distinct people.</b> On a local log, one person can hold every key.</li>
        <li><b>Hedera gives shared order and a timestamp.</b> It does not prove a verifier ran the benchmark.</li>
        <li><b>The test is {total} small coding tasks.</b> A gain here may not help your own agent.</li>
        <li><b>One shared test invites people to fit it.</b> Repeat runs and a wide margin slow this down. They do not stop it.</li>
      </ul>
    </div>
  );

  return [
    ...(next === null ? [] : [{ id: "next", label: "What the next agent reads", hint: "the real digest", content: next }]),
    { id: "goal", label: "Goal", hint: "the score to beat", content: goal },
    { id: "rules", label: "Rules", hint: "six the code enforces", content: rules },
    { id: "how", label: "How it works", hint: "problem, Darwin, loop", content: how },
    { id: "limits", label: "Limits", hint: "what it does not prove", content: limits },
  ];
}
