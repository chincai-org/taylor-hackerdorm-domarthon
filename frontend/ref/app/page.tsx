import Link from "next/link";
import { MiniTree } from "@/components/MiniTree";
import { PairPicker } from "@/components/PairPicker";
import { tasks } from "@/lib/format";
import { DEFAULT_DOMAIN, DEFAULT_HARNESS, DEFAULT_MODEL, DOMAINS, HARNESSES, MODELS } from "@/lib/catalog";
import { loadTreeEntry, TREES } from "@/lib/trees";

// The real tree is read through `petri export` on every request.
export const dynamic = "force-dynamic";

export default async function Home() {
  const loads = await Promise.all(TREES.map((t) => loadTreeEntry(t)));

  return (
    <main className="container">
      <section className="hero">
        <h1>Evolve an AI agent&apos;s harness. Every score is re-checked.</h1>
        <p className="sub">
          Pick a domain, a model and a harness. Petri grows a tree of experiments on the harness. Other keys re-run each
          change before it counts. Failures are kept, so the next agent does not repeat them.
        </p>
        <PairPicker
          domains={DOMAINS}
          models={MODELS}
          harnesses={HARNESSES}
          defaults={{ domain: DEFAULT_DOMAIN, model: DEFAULT_MODEL, harness: DEFAULT_HARNESS }}
          trees={Object.fromEntries(loads.flatMap((l) => (l.ok ? [[l.entry.slug, { total: l.data.stats.total, rejected: l.data.stats.rejected }]] : [])))}
        />
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Trees</h2>
          <span className="muted">{loads.length} trees across {new Set(loads.map((l) => l.entry.domain.key)).size} domains</span>
        </div>
        <ul className="cards">
          {loads.map((l) => {
            const e = l.entry;
            const head = l.ok ? l.data.nodes.find((n) => n.id === l.data.stats.head) : undefined;
            return (
              <li key={e.slug}>
                <Link className="card" href={`/tree/${e.slug}`}>
                  <div className="card-top">
                    <div>
                      <p className="card-title">{e.harness.name}</p>
                      <p className="card-sub">on {e.model.name}</p>
                    </div>
                    <span className="tag">{e.domain.name}</span>
                  </div>
                  <div className="card-mini">
                    {l.ok ? <MiniTree nodes={l.data.nodes} /> : <span className="muted">The tree did not load.</span>}
                  </div>
                  <p className="card-goal">{e.goal}</p>
                  {l.ok && (
                    <dl className="card-stats">
                      <div><dt>Versions</dt><dd>{l.data.stats.total}</dd></div>
                      <div><dt>Accepted</dt><dd>{l.data.stats.accepted}</dd></div>
                      <div><dt>Kept failures</dt><dd>{l.data.stats.rejected}</dd></div>
                      <div><dt>Best</dt><dd>{head ? tasks(head.detail.claimedMedianBp, l.data.bench.total).replace(" tasks", "") : "—"}</dd></div>
                    </dl>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

    </main>
  );
}
