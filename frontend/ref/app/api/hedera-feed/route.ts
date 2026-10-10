import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MIRRORS: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

type MirrorMessage = {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
  chunk_info?: { number: number; total: number } | null;
};

/**
 * New records on the tree's Hedera topic, read from the public mirror node.
 *
 * `after=-1` returns only the latest sequence number, so the page can start
 * watching from the moment it loaded. Any later call returns the records that
 * arrived since. No key is needed: the topic is public.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const topic = url.searchParams.get("topic") ?? "";
  const network = url.searchParams.get("network") ?? "testnet";
  const after = Number(url.searchParams.get("after") ?? "-1");
  const host = MIRRORS[network];
  if (!/^\d+\.\d+\.\d+$/.test(topic) || host === undefined || !Number.isInteger(after)) {
    return NextResponse.json({ error: "topic, network or after is not valid" }, { status: 400 });
  }
  const noStore = { headers: { "cache-control": "no-store" } };

  try {
    if (after < 0) {
      const res = await fetch(`${host}/api/v1/topics/${topic}/messages?limit=1&order=desc`, { cache: "no-store" });
      const data = (await res.json()) as { messages?: MirrorMessage[] };
      return NextResponse.json({ latest: data.messages?.[0]?.sequence_number ?? 0, messages: [] }, noStore);
    }

    const res = await fetch(
      `${host}/api/v1/topics/${topic}/messages?sequencenumber=gt:${after}&limit=50&order=asc`,
      { cache: "no-store" },
    );
    const data = (await res.json()) as { messages?: MirrorMessage[] };
    let latest = after;
    const messages: { seq: number; timestamp: string; pub: string; body: unknown }[] = [];
    for (const m of data.messages ?? []) {
      latest = Math.max(latest, m.sequence_number);
      if ((m.chunk_info?.total ?? 1) !== 1) continue; // Petri log lines always fit one chunk.
      try {
        const line = JSON.parse(Buffer.from(m.message, "base64").toString("utf8")) as {
          envelope?: { pub?: string; body?: unknown };
        };
        if (line.envelope?.pub && line.envelope.body) {
          messages.push({ seq: m.sequence_number, timestamp: m.consensus_timestamp, pub: line.envelope.pub, body: line.envelope.body });
        }
      } catch {
        // Not a Petri log line. Skip it.
      }
    }
    return NextResponse.json({ latest, messages }, noStore);
  } catch {
    return NextResponse.json({ error: "the mirror node did not answer" }, { status: 502 });
  }
}
