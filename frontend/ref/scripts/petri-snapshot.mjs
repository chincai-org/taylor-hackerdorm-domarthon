// Regenerates lib/snapshot/: the tree the site serves when the petri CLI cannot run.
// Vercel installs only the root package, and petri/.petri/identity.json is never committed,
// so `petri export` fails there. Run this after the tree changes: npm run petri:snapshot
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const petriRoot = process.env.PETRI_ROOT ?? path.join(root, "petri");
const tsx = path.join(petriRoot, "node_modules", ".bin", "tsx");

const petri = (args) =>
  execFileSync(tsx, ["src/cli/index.ts", ...args], {
    cwd: petriRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });

const tmp = path.join(os.tmpdir(), `petri-snapshot-${process.pid}.json`);
petri(["export", "--out", tmp]);
const data = JSON.parse(readFileSync(tmp, "utf8"));
rmSync(tmp, { force: true });

// The export lists the key of the machine that ran it. Drop that row when the key
// never reported, so the snapshot does not show the builder as a runner.
const me = JSON.parse(readFileSync(path.join(petriRoot, ".petri", "identity.json"), "utf8")).publicKey;
data.runners = data.runners.filter((r) => !(r.pub === me && r.reports === 0));

const digest = petri(["digest"]);
const start = digest.indexOf("# PETRI DIGEST");
const text = (start >= 0 ? digest.slice(start) : digest).trimEnd();

const dir = path.join(root, "lib", "snapshot");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "petri-export.json"), `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(path.join(dir, "petri-digest.json"), `${JSON.stringify({ text }, null, 2)}\n`);
console.log(`wrote lib/snapshot/ (${data.nodes.length} nodes, ${data.runners.length} runners, digest ${text.length} chars)`);
