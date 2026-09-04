/**
 * The workshop server.
 *
 * It exists for exactly one reason: a GitHub write credential cannot live in a
 * browser. Everything else, including the validator, runs client-side for fast
 * feedback. The server re-runs the same validator before writing, because a
 * client-side check is a courtesy to the artist, never a gate.
 *
 * Zero dependencies. Run: node server.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate } from './lib/validate.mjs';
import { makeStore } from './lib/store.mjs';
import { submitToBranch, whoami, exchangeOAuthCode } from './lib/github.mjs';

const env = k => process.env[k];
const CFG = {
  owner: env('ASSETS_OWNER') || 'juntaoli',
  repo: env('ASSETS_REPO') || 'todofarm-assets',
  appId: env('GH_APP_ID'),
  privateKey: (env('GH_APP_PRIVATE_KEY') || '').replace(/\\n/g, '\n'),
  clientId: env('GH_CLIENT_ID'),
  clientSecret: env('GH_CLIENT_SECRET'),
  assetsPath: env('ASSETS_PATH') || '../assets',
};
const PORT = Number(env('PORT') || 8787);
const MAX_UPLOAD = 2 * 1024 * 1024; // a 64x64 PNG is ~2KB; 2MB is absurdly generous and still bounds abuse

const store = makeStore(CFG);
const canWrite = Boolean(CFG.appId && CFG.privateKey);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = req => new Promise((resolve, reject) => {
  let n = 0; const parts = [];
  req.on('data', c => {
    n += c.length;
    if (n > MAX_UPLOAD) { reject(new Error('payload too large')); req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/config') {
      return json(res, 200, {
        repo: `${CFG.owner}/${CFG.repo}`, store: store.mode,
        canWrite, canSignIn: Boolean(CFG.clientId),
      });
    }

    if (p === '/api/catalogue') {
      const [{ classes, standard, tile }, slots] = await Promise.all([store.classes(), store.slots()]);
      return json(res, 200, { standard, tile, classes, slots: slots.sort((a, b) => a.id.localeCompare(b.id)) });
    }

    if (p === '/api/auth/callback' && url.searchParams.get('code')) {
      const token = await exchangeOAuthCode({ ...CFG, code: url.searchParams.get('code') });
      const me = await whoami(token);
      // The artist's token is never persisted. We keep the handle for attribution.
      res.writeHead(302, { Location: `/?artist=${encodeURIComponent(me.login)}` });
      return res.end();
    }

    if (p === '/api/submit' && req.method === 'POST') {
      if (!canWrite) return json(res, 503, { error: 'server has no GitHub App credentials; set GH_APP_ID and GH_APP_PRIVATE_KEY' });

      const body = JSON.parse(await readBody(req));
      const { slotId, artist, licence, pngBase64 } = body;
      if (!slotId || !artist || !licence || !pngBase64)
        return json(res, 400, { error: 'slotId, artist, licence and pngBase64 are all required' });

      const [{ classes }, slots] = await Promise.all([store.classes(), store.slots()]);
      const slot = slots.find(s => s.id === slotId);
      if (!slot) return json(res, 404, { error: `no slot "${slotId}"` });
      const cls = classes[slot.class];
      if (!cls) return json(res, 500, { error: `slot "${slotId}" has unknown class "${slot.class}"` });

      const bytes = new Uint8Array(Buffer.from(pngBase64, 'base64'));

      // Re-validate server-side. The browser already checked, but a client-side
      // check is a courtesy to the artist and is trivially bypassed.
      const result = await validate(bytes, { ...cls, id: slotId });
      if (!result.ok) {
        return json(res, 422, {
          error: 'failed validation',
          blocking: result.blocking.map(c => ({ id: c.id, label: c.label, value: c.value })),
        });
      }

      const branch = `art/${slotId}-${randomUUID().slice(0, 8)}`;
      // artistId is the GitHub numeric id when signed in. Logins get renamed;
      // the id never changes, so attribution keys on it where we have one.
      const updated = { ...slot, submissions: [...(slot.submissions || []),
        { artist, artistId: body.artistId || null, licence, at: new Date().toISOString(), branch }] };

      const pr = await submitToBranch(CFG, {
        branch,
        message: `add ${slotId} by @${artist}`,
        coAuthor: `${artist} <${artist}@users.noreply.github.com>`,
        files: [
          { path: `art/${slotId}@1x.png`, content: Buffer.from(bytes) },
          { path: `slots/${slotId}.json`, content: JSON.stringify(updated, null, 2) + '\n' },
        ],
        prTitle: `${slotId} by @${artist}`,
        prBody: [
          `Submitted through the workshop by **@${artist}**.`,
          '', `- slot: \`${slotId}\` (${slot.class})`,
          `- licence: **${licence}**`,
          `- passed ${result.checks.length} automated checks before submission`,
          result.warnings.length ? `- ${result.warnings.length} advisory: ${result.warnings.map(w => w.label).join(', ')}` : '',
          '', 'CI re-runs the same validator. Merging this PR is the approval.',
        ].filter(Boolean).join('\n'),
      });
      return json(res, 200, { ok: true, pr });
    }

    // static
    let file = p === '/' ? '/index.html' : p;
    if (file.startsWith('/lib/')) {
      const f = join(process.cwd(), file);
      if (existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return res.end(readFileSync(f));
      }
    }
    const full = join(process.cwd(), 'public', file);
    if (!full.startsWith(join(process.cwd(), 'public')) || !existsSync(full)) {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(readFileSync(full));
  } catch (e) {
    json(res, e.message === 'payload too large' ? 413 : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`workshop  http://localhost:${PORT}`);
  console.log(`  slots    ${store.mode}`);
  console.log(`  writes   ${canWrite ? `enabled -> ${CFG.owner}/${CFG.repo}` : 'DISABLED (no GitHub App credentials)'}`);
  console.log(`  sign-in  ${CFG.clientId ? 'enabled' : 'disabled'}`);
});
