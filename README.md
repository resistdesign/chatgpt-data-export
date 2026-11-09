# ChatGPT Data Export

A **local-first Electron desktop app** for exporting accessible ChatGPT data. Built with Node.js + TypeScript, licensed MIT by Resist Design.

The goal is a first-class backup experience: sign in once, save data locally, follow real progress, stop safely, resume, and verify what was actually saved. No Chrome extension, remote debugging, second Chrome instance, pasted bearer tokens, or reliance on OpenAI's email export.

> **v0.2.0 is an early development build.** The code and synthetic tests compile; the ChatGPT sign-in flow and private endpoints have **not been validated against a real signed-in Electron session**. Some SSO providers refuse embedded browsers. Run the small test first. Do not assume every account artifact is accessible.

## Run it on your Mac

Requires Node.js **22.12+**, Yarn, internet access, and macOS, Windows, or Linux with a graphical desktop. No preinstalled Chrome is needed.

```bash
git clone https://github.com/resistdesign/chatgpt-data-export.git
cd chatgpt-data-export
yarn install
yarn start
```

If you're testing an open PR, check out its feature branch before `yarn install`.

1. Click **Open ChatGPT sign-in**. An embedded Chromium window opens. Sign into your own ChatGPT account there, including any MFA. Close the sign-in window when you're done.
2. Click **Check connection** to confirm that the application can read your authenticated session.
3. Choose an ordinary **local folder** for the archive. Default: `~/ChatGPT-Data-Export`. Avoid a live cloud-synced folder during large backups.
4. Click **Test 25 chats per workspace** first. The pilot also checks **up to 3 representative Projects per workspace**, not every Project attachment; `projectCoverage` in each report shows the sampled scope. Inspect the results. Then click **Export everything available** to scan all Projects and resume from already verified files.
5. Click **Verify archive** to re-hash saved data offline, and **Open export folder** to review your files.

The application keeps its own encrypted/session cookie store **as managed by Electron/Chromium**, separate from Chrome. The exact at-rest protections vary by OS. It reuses the same persistent `persist:chatgpt-data-export` session on later launches. You don't need to alter Chrome's settings, install an extension or authorize Chrome debugging. The short-lived access token is kept in memory and is not stored by our app.

If ChatGPT or your identity provider refuses sign-in in an embedded Electron window, **the app will not bypass its restrictions**. The next step would be an officially supported authentication mechanism or a carefully reviewed separate adapter, not silently transferring Chrome cookies or bypassing account security.

## What we export

The existing checkpoint-based export engine remains unchanged in format and purpose:

- Personal and Business workspaces discoverable from the signed-in account.
- Main, archived, Project, and shared conversation listings.
- Raw conversation records; paginated conversations retain all fetched source pages. Legacy full-graph endpoints preserve branches where available.
- Project information and discoverable Project knowledge files.
- Available uploaded and generated `file_*` assets, plus recognized sandbox downloads, with SHA-256 hashes.
- Account data returned by accessible endpoints: legacy memories, settings, custom instructions, beta features, Library metadata and custom GPT listings.

**Important:** These are undocumented ChatGPT browser endpoints. Successful sign-in does not guarantee all data is retrievable. Improved memory, certain media formats, Library file bodies, standalone Space artifacts, scheduled tasks, and some custom GPT assets have **not been confirmed as fully exportable**. When an endpoint is denied, missing, or an asset fails, the exporter reports it instead of claiming success.

## Reliability

- Every conversation has a `complete.json` marker, referencing SHA-256 checksums.
- Files are written to temporary files and renamed into place after successful writes.
- Unchanged, verified conversations are reused when the app restarts.
- Individual missing attachments are retried on later runs.
- Journal entries are append-only, not a giant file rewritten for every conversation.
- Bounded concurrency, adaptive request pacing, and explicit rate-limit retries; extended 429s interrupt honestly rather than spinning forever.
- A small test is **always** marked incomplete, not misrepresented as an entire account backup; a 25-chat pilot tests at most three representative Projects to avoid a full Project attachment crawl.
- **Stop safely** cancels new work and retains saved checkpoints. If the app or system crashes, restart the app and use the same output folder to resume.
- Independent verification: use **Verify archive** in the app, or `yarn verify /path/to/archive` from a terminal (no ChatGPT login required).

### Files written

```text
~/ChatGPT-Data-Export/
  report.json
  workspaces/<workspace-fingerprint>/
    inventory.json
    account/                 # available metadata + per-endpoint status
    projects/<project-id>/   # Project info + accessible assets
    conversations/<conversation-id>/
      raw.json                # provider source JSON or source pages
      complete.json           # verified hash references, missing asset IDs
      assets-index.json
      assets/                 # binary files when available
    journal.jsonl             # append-only progress trail
    report.json              # scope counts, failures and integrity results
```

The output folder and Electron session contain **highly private material**. Never commit them or share them publicly. Tokens are never written to logs intentionally, but raw conversation data may itself contain secrets that were mentioned in chats.

## Developer commands

| Command | Purpose |
| --- | --- |
| `yarn start` | Build and launch the Electron app |
| `yarn build` | Compile TypeScript and stage desktop UI assets |
| `yarn typecheck` | TypeScript compilation checks |
| `yarn test` | Synthetic archive, discovery and Electron session tests |
| `yarn verify /path/to/archive` | Verify locally saved data without opening the desktop app |

The desktop app uses the Electron **main process** for networking and filesystem operations. Its untrusted ChatGPT login window is sandboxed, has `nodeIntegration: false`, and has **no preload bridge**. The application dashboard is a local page with a narrow allowlisted IPC bridge. The ChatGPT account session is persistent via Electron's `session.fromPartition('persist:chatgpt-data-export')`, and requests go through `Session.fetch`, using cookies in that session. No Chromium debugger is involved.

The archive engine (`src/exporter.ts`, `src/archive.ts`, `src/discovery.ts`, `src/assets.ts`) doesn't depend on Electron; it consumes an authenticated API interface. Installable Windows/macOS/Linux bundles, signing, notarization, and auto-updates are future milestones; this PR deliberately starts with a runnable developer build on your Mac.

## Project status and upstream inspiration

Version 0.2.0 is **not production certified**. The engine uses private APIs that can change at any time; check the account coverage reports. Source inspiration and endpoint research came from [CodingCat AI Chat Exporter](https://github.com/nikolaylosev/ai-chat-exporter), [ChatGPT Markdown Export](https://github.com/thekester/chatgpt-export) and [ChatGPTExporter Community](https://github.com/Trojon99/ChatGPTExporter-Community). No code from those projects was copied. This project isn't affiliated with OpenAI.

### Reading progress

The progress bar represents **attempts finished in the current stage**, not a promise that every file was recovered. During conversation capture, the dashboard separately shows **fully saved**, **partial**, **failed**, **reused** (a subset of fully saved), and **active**. The `x/y attempted` count can reach `y/y` even when the archive is partial, and the report will say so. The clock shows total runtime and time spent in the current stage separately; we don't predict completion time while retrying unpredictable file downloads. Request cooldowns appear on their own line and never replace the capture statistics.

### Recover missing files without restarting the export

When the app opens, **Existing archive** summarizes the saved conversation checkpoints and missing-file references on disk. These are metadata counts, **not hash-verified results**. `Verify archive` remains the integrity check.

Use **Recover next 10 missing files** to try one small batch of previously missing conversation/Project attachments. This pass selects only saved missing-file records and reads raw conversation content from the local archive. It does **not** enumerate conversations, download previously completed conversations, or repeat the whole Project crawl. Each click rotates to the next batch so permanently inaccessible files do not block later ones. The existing file hashes and completion markers are preserved; successful recoveries update their checkpoint and manifest records. Recovery produces `recovery-latest.json` and can be stopped safely.

An unavailable resource is still unavailable if the provider denies every permitted retrieval path. Recovery cannot guarantee 100% coverage of internal ChatGPT data.
