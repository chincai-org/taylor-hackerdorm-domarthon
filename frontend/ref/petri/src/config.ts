/**
 * Configuration. See SPEC.md section 4.
 *
 * `.petri/config.json` is never hashed and never signed, so it is written
 * pretty-printed for a human to read.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { byteCompare } from './core/canonical.js';
import { notFoundError, usageError } from './core/errors.js';
import { REPO_ROOT } from './core/root.js';
import { Hex64, TreeId } from './core/schema.js';

export { Hex64, TreeId };

export const AccountId = z.string().regex(/^\d+\.\d+\.\d+$/);

export const PolicySchema = z.strictObject({
  maxRunSpreadBp: z.int().min(0).max(10000).default(3000),
  maxRunnerDisagreementBp: z.int().min(0).max(10000).default(1000),
  minDeltaBp: z.int().min(1).max(10000).default(1000),
  minRuns: z.int().min(3).max(99).default(5),
  minVerifications: z.int().min(2).max(8).default(2),
  trustedRunners: z.array(Hex64).max(64).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export const PetriConfigSchema = z.strictObject({
  bench: z.strictObject({ id: Hex64, name: z.string().min(1).max(64) }),
  hedera: z.strictObject({
    mirrorRest: z.array(z.url()).min(1),
    network: z.enum(['testnet', 'mainnet', 'previewnet']),
    operatorId: AccountId,
    topicId: AccountId,
  }).optional(),
  ledger: z.enum(['hcs', 'local']),
  mode: z.enum(['live', 'replay']),
  policy: PolicySchema,
  runsPerVerification: z.int().min(3).max(99).default(5),
  treeId: TreeId,
  version: z.literal(1),
});
export type PetriConfig = z.infer<typeof PetriConfigSchema>;

/**
 * The config of the checkout that ships this CLI. It is a fallback only.
 * Every command passes `configPath(--root)` from src/store/paths.ts instead.
 */
export const CONFIG_PATH = join(REPO_ROOT, '.petri', 'config.json');

/** The policy every field of which is the documented default. Section 4.1. */
export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

/**
 * Read and validate `.petri/config.json`.
 * `runsPerVerification` must be odd, because an even run count has no unique median.
 */
export function loadConfig(path: string = CONFIG_PATH): PetriConfig {
  if (!existsSync(path)) {
    throw notFoundError(`petri: no config at ${path}. Run \`petri init\` first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (e) {
    throw usageError(`petri: ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = PetriConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(`petri: ${path} is not a valid config: ${parsed.error.message}`);
  }
  const cfg = parsed.data;
  if (cfg.runsPerVerification % 2 === 0) {
    throw usageError(
      `petri: runsPerVerification is ${cfg.runsPerVerification}. It must be odd, `
      + 'because an even run count has no unique median.',
    );
  }
  if (cfg.ledger === 'hcs' && cfg.hedera === undefined) {
    throw usageError('petri: ledger is "hcs" but the config carries no `hedera` block.');
  }
  return cfg;
}

/** Validate, then write atomically. A crash never leaves a half-written config. */
export function saveConfig(config: PetriConfig, path: string = CONFIG_PATH): void {
  const parsed = PetriConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw usageError(`petri: refusing to write an invalid config: ${parsed.error.message}`);
  }
  if (parsed.data.runsPerVerification % 2 === 0) {
    throw usageError('petri: runsPerVerification must be odd.');
  }
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(stableOrder(parsed.data), null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Sort keys so a diff of the config file stays small.
 *
 * This is the same ordering as the pretty writer in src/store/json.ts. Config
 * lives at the bottom of the import graph and may not import from src/store/,
 * so the eight lines are repeated here. Neither output is ever hashed.
 */
function stableOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableOrder);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(byteCompare)) out[k] = stableOrder(src[k]);
    return out;
  }
  return v;
}
