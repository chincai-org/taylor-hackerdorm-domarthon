import Link from "next/link";
import { notFound } from "next/navigation";
import { buildPanels } from "@/components/InfoPanels";
import { Panels } from "@/components/Panels";
import { Stats } from "@/components/Stats";
import { TreeWorkspace } from "@/components/TreeWorkspace";
import { LiveRefresh } from "@/components/LiveRefresh";
import { buildForest } from "@/lib/layout";
import { parseSlug } from "@/lib/catalog";
import { findTree, loadTreeEntry } from "@/lib/trees";

export const dynamic = "force-dynamic";

export default async function TreePage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { slug } = await params;
  const { view } = await searchParams;
  const entry = findTree(slug);
  if (!entry) {
    const pair = parseSlug(slug);
    if (!pair) notFound();
    return (
      <main className="container container-wide">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Trees</Link><span aria-hidden="true">/</span><span>{pair.domain.name}</span><span aria-hidden="true">/</span><span>{pair.harness.name} × {pair.model.name}</span>
        </nav>
        <div className="page-head">
          <div>
            <h1>{pair.harness.name} <span className="h1-sub">× {pair.model.name} ({pair.domain.name})</span></h1>
            <p className="sub">{pair.harness.note}</p>
          </div>
        </div>
        <section className="empty-pair">
          <h2>No tree yet</h2>
          <p>No experiments are recorded for this pair. The first version of the harness becomes the root of the tree.</p>
          <ol>
            <li>Add an adapter so Petri can run {pair.harness.name} against the benchmark.</li>
            <li>Run <code>pnpm petri init</code> in petri/ to record the root version.</li>
            <li>Run <code>pnpm petri evolve --mode live</code> to propose and measure the first change.</li>
          </ol>
          <Link className="btn" href="/">← Back to trees</Link>
        </section>
      </main>
    );
  }
  const load = await loadTreeEntry(entry, true);

  return (
    <main className="container container-wide">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Trees</Link><span aria-hidden="true">/</span><span>{entry.domain.name}</span><span aria-hidden="true">/</span><span>{entry.harness.name} × {entry.model.name}</span>
      </nav>

      <div className="page-head">
        <div>
          <h1>{entry.harness.name} <span className="h1-sub">× {entry.model.name} ({entry.domain.name})</span></h1>
        </div>
      </div>

      {load.ok ? (() => {
        const d = load.data;
        return (
          <>
            {d.nodes.length === 0 ? (
              <p className="empty">The tree is empty. Run <code>pnpm petri init</code> in petri/.</p>
            ) : (
              <><LiveRefresh />
              <TreeWorkspace
                nodes={d.nodes}
                forest={buildForest(d.nodes)}
                initial={d.stats.head || d.nodes[d.nodes.length - 1]!.id}
                minVerifications={d.policy.minVerifications}
                minDeltaBp={d.policy.minDeltaBp}
                benchTotal={d.bench.total}
                hedera={d.hedera ?? null}
                initialView={view === "stats" ? "stats" : "tree"}
                stats={<Stats d={d} />}
                info={<Panels panels={buildPanels(d, load.digest)} />}
              />
              </>
            )}
          </>
        );
      })() : (
        <section className="load-error" role="alert">
          <h2>The tree did not load</h2>
          <p>The page runs <code>petri export</code> in <code>{load.root}</code>. It failed with:</p>
          <pre>{load.error}</pre>
          <ol>
            <li>Run <code>pnpm install</code> in petri/.</li>
            <li>Run <code>pnpm petri tree</code> in petri/ and check it works.</li>
          </ol>
        </section>
      )}
    </main>
  );
}
