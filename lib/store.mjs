/**
 * Where slot definitions come from.
 *
 * In development that is a local checkout of the assets repo, so you can work
 * offline with no credentials at all. In production it is the GitHub API.
 * Same interface either way, so the server code never branches on it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from './github.mjs';

export function makeStore(cfg) {
  const local = cfg.assetsPath && existsSync(cfg.assetsPath) ? cfg.assetsPath : null;

  return {
    mode: local ? `local (${local})` : `github (${cfg.owner}/${cfg.repo})`,

    async classes() {
      const raw = local
        ? readFileSync(join(local, 'classes.json'), 'utf8')
        : await readFile(cfg, 'classes.json');
      return JSON.parse(raw);
    },

    async slots() {
      if (local) {
        return readdirSync(join(local, 'slots')).filter(f => f.endsWith('.json'))
          .map(f => JSON.parse(readFileSync(join(local, 'slots', f), 'utf8')));
      }
      const listing = JSON.parse(await readFile(cfg, 'slots'));
      return Promise.all(listing.filter(f => f.name.endsWith('.json'))
        .map(async f => JSON.parse(await readFile(cfg, `slots/${f.name}`))));
    },
  };
}
