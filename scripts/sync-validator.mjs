/**
 * lib/validate.mjs is vendored from the assets repo, which is its home: the
 * validator IS the standard, so it lives with the standard. Drift between the
 * two would mean an artist sees one verdict in the browser and a different one
 * on the pull request, which is the single worst failure this system can have.
 *
 * Run: node scripts/sync-validator.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = process.env.ASSETS_PATH || '../assets';
const from = `${SRC}/lib/validate.mjs`, to = 'lib/validate.mjs';
const check = process.argv.includes('--check');
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);

if (!existsSync(from)) {
  console.error(`cannot find ${from}. Set ASSETS_PATH to your assets checkout.`);
  process.exit(1);
}
const src = readFileSync(from), cur = existsSync(to) ? readFileSync(to) : Buffer.alloc(0);

if (src.equals(cur)) { console.log(`in sync (${sha(src)})`); process.exit(0); }
if (check) {
  console.error(`OUT OF SYNC\n  assets   ${sha(src)}\n  workshop ${sha(cur)}\nRun: npm run sync`);
  process.exit(1);
}
writeFileSync(to, src);
console.log(`synced ${sha(cur)} -> ${sha(src)}`);
