/**
 * GitHub write path for the workshop.
 *
 * The artist never needs repo write access and never touches git. The workshop
 * authenticates as a GitHub App, commits their PNG onto a fresh branch in the
 * assets repo, and opens a pull request. Merging that PR is the approval step.
 *
 * We use the Git Data API rather than the Contents API because a submission is
 * two files (the PNG and the updated slot JSON) that must land in one commit.
 * The Contents API writes one file per call, which would produce two commits
 * and a window where the repo is inconsistent.
 *
 * Zero dependencies: RS256 signing comes from node:crypto.
 */
import { createSign } from 'node:crypto';

const API = 'https://api.github.com';

const b64 = s => Buffer.from(s).toString('base64url');

/** Mint the short-lived JWT that identifies the App itself. */
function appJWT({ appId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  // iat is backdated 60s because GitHub rejects tokens issued in its future.
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
}

async function gh(url, { token, method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'todofarm-workshop',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${data?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.remaining = res.headers.get('x-ratelimit-remaining');
    throw err;
  }
  return data;
}

/** Exchange the App JWT for an installation token, which is what can write. */
export async function installationToken(cfg) {
  const jwt = appJWT(cfg);
  const inst = await gh(`/repos/${cfg.owner}/${cfg.repo}/installation`, { token: jwt });
  const t = await gh(`/app/installations/${inst.id}/access_tokens`, { token: jwt, method: 'POST' });
  return t.token; // expires in one hour, so mint per request rather than caching
}

/**
 * Commit a submission onto a new branch and open a PR.
 * files: [{ path, content }] where content is a Buffer or a string.
 */
export async function submitToBranch(cfg, { branch, message, files, prTitle, prBody }) {
  const token = await installationToken(cfg);
  const base = `/repos/${cfg.owner}/${cfg.repo}`;

  const repo = await gh(base, { token });
  const head = await gh(`${base}/git/ref/heads/${repo.default_branch}`, { token });
  const baseSha = head.object.sha;

  // One blob per file. Binary must go up as base64, which is why the PNG never
  // passes through JSON as a raw string.
  const tree = [];
  for (const f of files) {
    const isBuf = Buffer.isBuffer(f.content);
    const blob = await gh(`${base}/git/blobs`, {
      token, method: 'POST',
      body: {
        content: isBuf ? f.content.toString('base64') : f.content,
        encoding: isBuf ? 'base64' : 'utf-8',
      },
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(`${base}/git/trees`, {
    token, method: 'POST', body: { base_tree: baseSha, tree },
  });
  const commit = await gh(`${base}/git/commits`, {
    token, method: 'POST', body: { message, tree: newTree.sha, parents: [baseSha] },
  });
  await gh(`${base}/git/refs`, {
    token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  const pr = await gh(`${base}/pulls`, {
    token, method: 'POST',
    body: { title: prTitle, body: prBody, head: branch, base: repo.default_branch },
  });
  return { number: pr.number, url: pr.html_url, sha: commit.sha, branch };
}

/** Read a file from the assets repo. Used when the workshop runs detached from a checkout. */
export async function readFile(cfg, path) {
  const token = await installationToken(cfg);
  const r = await gh(`/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    token, accept: 'application/vnd.github.raw',
  });
  return typeof r === 'string' ? r : JSON.stringify(r);
}

/** Identify the signed-in artist. Read-only: it never grants repo write. */
export async function whoami(userToken) {
  return gh('/user', { token: userToken });
}

export async function exchangeOAuthCode({ clientId, clientSecret, code }) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const d = await res.json();
  if (d.error) throw new Error(`${d.error}: ${d.error_description || ''}`);
  return d.access_token;
}
