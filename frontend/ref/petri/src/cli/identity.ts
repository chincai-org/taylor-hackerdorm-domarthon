/**
 * `petri id` — the ed25519 key pair that IS this runner's identity (§1, §5).
 *
 * There is no registry. The key is the name. A key file is never overwritten,
 * and there is no revocation (§18.6).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';

import type { Command } from 'commander';

import { createIdentity, loadIdentity, type IdentityFile } from '../trust/identity.js';
import { identityPath } from '../store/paths.js';
import { EXIT, fail } from './exit.js';
import { globalOptions, out } from './context.js';

export function registerIdentity(program: Command): void {
  const group = program.command('id').description('this runner\'s ed25519 identity');

  group
    .command('create')
    .description('create the key pair. It never overwrites an existing key.')
    .option('--label <name>', 'a human name for this machine')
    .action((opts: { label?: string }, cmd: Command) => {
      const g = globalOptions(cmd);
      const path = identityPath(g.root);
      if (existsSync(path)) {
        fail(
          EXIT.USAGE,
          `${path} already exists. Petri never overwrites a key.\n` +
            '       Delete it by hand if you truly want a new identity. Past signatures\n' +
            '       made with the old key stay valid forever. There is no revocation.',
        );
      }
      const file: IdentityFile = createIdentity(path, opts.label ?? hostname());
      if (g.json) {
        out(
          JSON.stringify(
            { runnerId: file.runnerId, publicKey: file.publicKey, label: file.label, path },
            null,
            2,
          ),
        );
        return;
      }
      out(`runner id  ${file.runnerId}`);
      out(`label      ${file.label}`);
      out(`path       ${path}  (mode 0600)`);
      out('');
      out('The private key never leaves this machine. Never commit identity.json.');
    });

  group
    .command('show')
    .description('print this runner\'s public key')
    .action((_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const path = identityPath(g.root);
      let identity;
      try {
        identity = loadIdentity(path);
      } catch (err) {
        fail(EXIT.NOT_FOUND, (err as Error).message);
      }
      const raw = JSON.parse(readFileSync(path, 'utf8')) as IdentityFile;
      if (g.json) {
        out(
          JSON.stringify(
            { runnerId: identity.runnerId, label: identity.label, createdAt: raw.createdAt },
            null,
            2,
          ),
        );
        return;
      }
      out(`runner id  ${identity.runnerId}`);
      out(`label      ${identity.label}`);
      out(`created    ${raw.createdAt}`);
    });

  group
    .command('path')
    .description('print the identity file path')
    .action((_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const path = identityPath(g.root);
      if (!existsSync(path)) {
        out(path);
        process.stderr.write('petri: that file does not exist yet. Run `petri id create`.\n');
        return;
      }
      const mode = statSync(path).mode & 0o777;
      out(path);
      process.stderr.write(`mode 0${mode.toString(8)}\n`);
    });
}
