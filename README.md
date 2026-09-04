# Sprite Workshop

The web app artists use to submit art to [todofarm-assets](../assets). They pick an open slot, drop a PNG, and the workshop opens a pull request for them.

**Artists never need repo write access and never touch git.**

## Why there is a server at all

Everything except one thing could be a static page. That one thing is the GitHub write credential, which cannot live in a browser, because anything shipped to a browser is public.

So the server does exactly two jobs: hold the credential, and re-run the validator before writing. Nothing else.

```
artist's browser                  workshop server              assets repo
  pick a slot                     
  drop a PNG                      
  validate  ──────────────────────────────────────────────►    (same file)
  see the verdict instantly       
  press submit  ─────────────►    re-validate                  
                                  (never trust the client)     
                                  commit + open PR  ───────►   branch + PR
                                                               CI re-validates
                                                               merge = approval
```

## The validator runs in three places and is one file

[`lib/validate.mjs`](lib/validate.mjs) is vendored from the assets repo, which is its home: the validator **is** the standard, so it lives with the standard.

| where | why |
|---|---|
| the artist's browser | instant feedback, before anything is uploaded |
| this server | a client-side check is a courtesy, never a gate |
| CI in the assets repo | the last word, and it runs on every PR |

Drift between them is the worst failure this system can have, because an artist would see one verdict here and a different one on their pull request. `npm run sync:check` fails the build if the copies differ.

## Run it

```bash
cp .env.example .env
npm start
```

With no credentials it runs read-only: the catalogue loads from a local assets checkout and submissions are disabled with a visible banner. That is deliberate, so you can develop the whole UI offline.

To enable submissions, create a **GitHub App**, install it on the assets repo, and set `GH_APP_ID` and `GH_APP_PRIVATE_KEY`.

Repository permissions the App needs:

| permission | level | for |
|---|---|---|
| Contents | read and write | create the branch and commit the PNG |
| Pull requests | read and write | open the PR |
| Metadata | read | mandatory, GitHub requires it |

A GitHub App is the right credential here rather than a personal token: it is scoped to one repo, its installation tokens expire in an hour, and it gets its own rate limit rather than burning a human's.

## Endpoints

| | |
|---|---|
| `GET /api/config` | what the server can do, so the UI can disable what it cannot |
| `GET /api/catalogue` | classes and slots |
| `POST /api/submit` | validate, commit, open a PR |
| `GET /api/auth/callback` | optional OAuth, only to capture a handle for attribution |

`POST /api/submit` returns **422 with the exact failing rules** when validation fails, so a bypassed client check produces a specific error rather than a generic rejection.

## Deliberate limits

- **Upload cap is 2MB.** A 64x64 PNG is about 2KB, so this is absurdly generous and still bounds abuse.
- **Artist tokens are never persisted.** Only the handle is kept, for attribution.
- **One PNG plus one slot JSON land in a single commit.** That is why this uses the Git Data API rather than the Contents API, which writes one file per call and would leave the repo briefly inconsistent.

## Layout

```
server.mjs           http server and the three API routes
lib/github.mjs       GitHub App auth (RS256 via node:crypto) and the commit + PR path
lib/store.mjs        slots from a local checkout in dev, from the API in prod
lib/validate.mjs     vendored from the assets repo. do not edit here.
public/              the app. imports the same validator the server runs.
scripts/             sync-validator
```

No dependencies anywhere. Node 18+.

## Hardening notes

Six things verified against GitHub's docs that are easy to get wrong and expensive to discover late.

1. **`POST /git/trees` without `base_tree` deletes every file in the repo** in one commit. Documented behaviour, not a bug. Asserted before every call.
2. **`POST /git/blobs` defaults to `utf-8`.** A PNG uploaded without an explicit `"encoding": "base64"` is silently corrupted.
3. **A custom `author` field forfeits the Verified badge.** Nobody notices until a branch protection rule requiring signed commits starts rejecting the bot. Attribution uses a `Co-authored-by:` trailer instead.
4. **Installation tokens are cached for 50 minutes.** Minting one per submission burns a separate secondary limit of 2,000 access-token requests per hour.
5. **Mutating GitHub calls are serialised.** GitHub's own guidance is to make write requests serially rather than concurrently to stay inside secondary rate limits.
6. **GitHub hands you a PKCS#1 key; Web Crypto only accepts PKCS#8.** `node:crypto` accepts both, so this server is fine, but an edge runtime would fail with an opaque `DataError` at request time in production. Tell them apart by the first line: `BEGIN RSA PRIVATE KEY` is PKCS#1. Convert with `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`. **Never paste an App private key into a web-based converter** — it is commit access to the assets repo.
