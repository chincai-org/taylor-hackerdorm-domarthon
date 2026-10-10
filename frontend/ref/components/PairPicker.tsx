"use client";

import Link from "next/link";
import { useState } from "react";
import { slugOf, type DomainOption, type HarnessOption, type ModelOption } from "@/lib/catalog";

interface Props {
  domains: DomainOption[];
  models: ModelOption[];
  harnesses: HarnessOption[];
  defaults: { domain: string; model: string; harness: string };
  /** Trees that exist, by slug. */
  trees: Record<string, { total: number; rejected: number }>;
}

/** Pick a domain, a model and a harness. The button opens that tree, or its empty page. */
export function PairPicker({ domains, models, harnesses, defaults, trees }: Props) {
  const [domain, setDomain] = useState(defaults.domain);
  const [model, setModel] = useState(defaults.model);
  const [harness, setHarness] = useState(defaults.harness);
  const slug = slugOf(domain, harness, model);
  const tree = trees[slug];

  return (
    <div className="composer">
      <div className="composer-row">
        <label className="field" htmlFor="pick-domain">
          <span>Domain</span>
          <select id="pick-domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            {domains.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
          </select>
        </label>
        <label className="field" htmlFor="pick-model">
          <span>Model</span>
          <select id="pick-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
          </select>
        </label>
        <label className="field" htmlFor="pick-harness">
          <span>Harness</span>
          <select id="pick-harness" value={harness} onChange={(e) => setHarness(e.target.value)}>
            {harnesses.map((h) => <option key={h.key} value={h.key}>{h.name}</option>)}
          </select>
        </label>
        <Link className="btn btn-primary" href={`/tree/${slug}`}>{tree ? "Open tree →" : "Start a tree →"}</Link>
      </div>
      <p className="composer-note">{tree ? `${tree.total} versions · ${tree.rejected} failures kept` : "No tree yet for this combination."}</p>
    </div>
  );
}
