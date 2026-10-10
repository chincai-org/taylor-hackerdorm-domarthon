import type { Metadata } from "next";
import Link from "next/link";
import { SelfieDemo } from "@/components/SelfieDemo";
import { STATUS_WORD } from "@/lib/format";
import { loadTree } from "@/lib/tree";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Selfie Check · Petri" };

const TREE = "/tree/coding--petri-harness-v1--claude-sonnet-5";

export default async function SelfiePage({ searchParams }: {
  searchParams: Promise<{ node?: string; report?: string }>;
}) {
  const { node = "", report = "" } = await searchParams;
  const load = await loadTree();
  const found = load.ok && node !== "" ? load.data.nodes.find((n) => n.id.startsWith(node)) : undefined;

  return (
    <main className="container selfie-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Trees</Link><span aria-hidden="true">/</span>
        <Link href={TREE}>Petri harness v1 × Claude Sonnet 5</Link><span aria-hidden="true">/</span>
        <span>Selfie Check</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>Prove the verifier is a human</h1>
          <p className="sub">After a key re-runs a version, the person behind that key completes a World ID Selfie Check. One face can back one verification of a version, however many keys it holds.</p>
        </div>
      </div>
      <SelfieDemo
        node={found?.id ?? node}
        short={found?.short ?? node.slice(0, 8)}
        status={found ? STATUS_WORD[found.status] : null}
        hypothesis={found?.hypothesis ?? null}
        report={report}
        treeHref={TREE}
      />
    </main>
  );
}
