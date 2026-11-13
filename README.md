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

### Safe attachment diagnostics

**Copy safe diagnostic summary** copies only aggregate missing-file counts and a histogram of download-method failures (such as HTTP 403 with a workspace header). The diagnostic summary is generated from the existing archive without using the network. It intentionally excludes account identifiers, conversation and file identifiers, filenames, request URLs, access tokens, signed links, and raw server responses. The histogram counts failed **route attempts**, not unique files.

### Observe ChatGPT's real Project-file download method (privacy-safe)

For a file that remains inaccessible, click **Observe one ChatGPT download**. The app opens its already-authenticated ChatGPT window. Navigate to a Project and click Download on one of its files. Return to the export dashboard and click **Stop observing download**, then **Copy safe diagnostic summary**. The summary adds the actual successful/failed file API **route shapes, query parameter names, and HTTP statuses** seen in the embedded window. It captures no file IDs, names, URLs, response bodies, cookies, access tokens, or request headers, and never writes the observed requests to disk. Observation is strictly opt-in and only observes the app-owned sign-in window. It stops when that window closes. No external Chrome settings or debugging connection are needed.

If ChatGPT's own interface cannot download that file, this suggests the issue may be provider-side or permission-related, not merely the exporter's API route.

### Download route compatibility (November 2026)

During an opt-in observation of ChatGPT's own authenticated window, Project downloads returned HTTP 200 from `/backend-api/files/download/{id}` with the query names `gizmo_id`, `download_intent`, and `inline`. The exporter now prioritizes that combination for Project files, accepting either a direct file or a JSON descriptor with a signed estuary URL. Chats inside Projects also try the observed `/backend-api/files/{id}/simple` and context-scoped download routes with both conversation and Project IDs.

This improves route compatibility but does **not** guarantee permissions for every historical file. Do not treat a 200 response to a metadata endpoint as proof that an asset was downloaded; only saved, hashed file bytes count.

Targeted recovery currently prioritizes missing Project files to validate their corrected authenticated download route, then processes conversation attachments. It continues to rotate through records rather than repeatedly starting with the same inaccessible file.

### Recovery accounting and request comparison

A missing-file recovery now distinguishes **selected file references** from **actual download attempts**. Old missing IDs that are no longer present in saved Project/conversation source metadata are reported as **absent from saved source metadata**, never counted as completed network attempts. The last pass's breakdown is included in the privacy-safe diagnostic summary. A pass selecting 10 references may issue fewer than 10 download attempts.

Optional browser request observation now records **literal boolean values only** for `inline` and `download_intent`, and an allowlist of **request header names** only (whether Authorization, workspace account ID, cookies, etc. were present). It never records header values, identifiers, filenames, raw URLs, or other query values. This allows comparison against the exporter's request structure without disclosing credentials.

The opt-in download observer also compares a browser file request to the archive's missing **Project/file identifier pair entirely in memory**, reporting only whether it is the **same missing Project file**. A successful browser response for a different file is not evidence that the missing one is accessible. No identifiers are copied to diagnostics.

**Exact-file browser comparison:** The observation button identifies one missing Project attachment that still exists in the saved Project file listing. It shows the original Project and filename only in the user's local dashboard and opens that Project in the app-owned ChatGPT window. The private identifiers are compared in memory to observed download requests; the copied summary includes only "same missing Project file: YES/no." If that attachment is no longer available in ChatGPT's UI, note that rather than assuming a different file's successful download proves accessibility.


### Recommended: back up the conversation history before attachments

Click **Back up conversations first** for an account-wide, resumable, history-first pass. This reuses the existing inventory and verified conversation checkpoints; saves raw conversation JSON and Project/account metadata; and indexes missing attachments **without downloading any asset bytes**. Previously verified attachments are retained in their original locations, and unavailable/deferred attachments remain explicitly marked missing. Project file lists and individual asset references can be recovered later. The archive correctly remains **partial** while attachments are deferred.

**Include attachments (slower)** is a separate mode for downloading accessible file bytes. It will retry inaccessible attachments, so run the fast pass first when the immediate priority is backing up the full conversation history. The 25-item test still includes attachment attempts. An interruption retains completed conversation checkpoints; resume the same mode without clearing the archive.


### Resuming after HTTP 429 rate limits

If the ChatGPT server begins returning HTTP 429 repeatedly, use **Stop safely** and quit Electron before updating. Then, in the repository, run:

```bash
git pull --ff-only
yarn start
```

Keep the original output directory selected and click **Back up conversations first**. The existing conversation inventory and verified per-conversation checkpoints are reused; do **not** delete or clear the archive.

The request scheduler is shared by all concurrent workers. A 429 now triggers a **real global pause** (starting around 30 seconds, doubling on repeated 429s, capped around five minutes before jitter), extended if ChatGPT sends a longer `Retry-After`. Requests already waiting in line recheck the deadline; they cannot slip past a newer pause. After five successful responses, pacing eases gradually. The UI distinguishes ordinary **Request spacing** from **Rate-limit pause**. **Stop safely** interrupts either wait without losing saved checkpoints.

This reduces wasted requests and protects the session, but cannot exceed the server's permitted rate. If 429s persist after the bounded retries, the run stops rather than claiming an incomplete conversation was saved; resume later from the same folder.


### Ongoing backup: sync recent conversations (new November 2026)

After completing an initial export, open the same archive folder and click **Sync new & updated**. The app checks the newest main, archived, Project and shared listings and merges them into your existing inventory. It stops paginating a listing once it reaches a full page of already-known, unchanged records. It then downloads only **new or updated conversation records**; old, unchanged chat records and existing files are never re-downloaded.

The sync uses the same per-conversation atomic checkpoints and adaptive 429 backoff as the main export, with attachment downloads deferred. The existing complete inventory is preserved if discovery is interrupted; when discovery succeeds, the merged inventory is saved before capture, so a later resume can finish any newly discovered chats. The dashboard reports how many new and updated conversations were found. Project-only chats and shared links are checked as well. An initial run with no valid saved inventory automatically performs a full discovery.

**Scope:** Recent sync relies on provider listings sorted by recent activity. It's optimized for new/updated content, not an exhaustive revalidation of old, deleted, deeply buried or reordered data. Use a full inventory refresh for independent comprehensive reconciliation. The **Back up stored inventory** action reuses the saved list; it does not discover newer chats.


For edited conversations, incremental sync **retains the previously downloaded raw bytes** and previous completion metadata in a `revisions/` directory, then writes the new version under a content-addressed path and updates its checkpoint. The dashboard shows the timestamp and newly found/updated counts from the latest recent sync.


### Sync missing attachments from the existing archive

Click **Sync missing attachments** after the conversation backup. The sync reads only the locally saved inventories, raw conversation JSON, and missing-file checkpoints. It does not re-download or re-enumerate conversations. It tries deferred attachment references (conversations before Project files), hashes saved bytes, and writes per-file atomic progress markers. Recovered files remain recovered after a crash, restart, session expiry or **Stop safely**.

During the automatic bulk pass, **each file receives at most two download-route trials** instead of trying every route and every header combination. A shared in-memory route policy learns which route/header combination has actually downloaded bytes, prefers it on later files, and explores alternatives when routes fail. An HTTP 404 favors a different route rather than immediately repeating the same route without a workspace header; HTTP 403 may warrant one default-scope attempt. The more exhaustive legacy route fallback remains available through **Retry 10 inaccessible files**.

Previously denied attachments (permission error, HTTP 401/403/404, or an exhausted automatic route budget) are **skipped by default** rather than retried thousands of times. Such files remain explicitly missing and can be retried manually with **Retry 10 inaccessible files**. An automatic two-route failure is **not proof that all routes fail**, or that ChatGPT permanently deleted the file. Any *new* inaccessible file is recorded in its saved index/marker and skipped on subsequent automatic syncs.

To avoid repeating denied requests indefinitely, automatic sync also **pauses after 60 consecutive unavailable files**; untouched deferred references stay eligible for later runs. Restarting the pass uses the same archive directory and verified checkpoints.

The dashboard tracks recovered, actual download attempts, newly unavailable, previously denied/skipped, unmatched references, and missing local source records. Live per-attachment progress is separate from conversation history. The final checkpoint `attachment-sync-latest.json` records aggregate progress only, without tokens or filenames. A stopped or rate-limited run can be resumed with the same button, unchanged output directory, and authenticated Electron session.

**Rate limiting:** The automatic attachment sync spaces ChatGPT API requests by at least **2.5 seconds**, shared across all route trials. Binary attachment calls also share the adaptive HTTP 429 backoff and `Retry-After` handling used for conversation requests. The provider may still throttle or deny downloads. The tool cannot guarantee that every historical attachment can be recovered.
