import { NextResponse } from "next/server";
import { runSimulatedSelfieCheck } from "@/lib/selfie-demo";

export const dynamic = "force-dynamic";

/** Simulated Selfie Check, then the real Hedera push. See lib/selfie-demo.ts. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { node?: unknown; report?: unknown };
  const result = await runSimulatedSelfieCheck(String(body.node ?? ""), String(body.report ?? ""));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
