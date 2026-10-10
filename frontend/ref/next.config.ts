import path from "node:path";
import type { NextConfig } from "next";

// ui/ sits inside petri/, which sits inside a repo with its own lockfile.
// Pin the root so Next does not guess the wrong workspace.
const nextConfig: NextConfig = {
  turbopack: { root: path.join(__dirname) },
  devIndicators: false
};

export default nextConfig;
