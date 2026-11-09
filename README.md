# ChatGPT Data Export

**Local-first, crash-resumable ChatGPT archive tool.** Node.js + TypeScript, licensed MIT by Resist Design.

This project exists because a backup that silently stops, restarts from zero, or calls missing data "complete" is not a backup.

## Get started (macOS, Windows or Linux)

Requires Node.js **20.19+**, Yarn, and **Google Chrome 144+** already running with a signed-in ChatGPT tab.

```bash
git clone https://github.com/resistdesign/chatgpt-data-export.git
cd chatgpt-data-export
yarn install
yarn build
yarn start
```

**One-time browser setup (existing Chrome only):**

1. In the Chrome window where you're already signed in to ChatGPT, visit `chrome://inspect/#remote-debugging`.
2. Turn on **Allow remote debugging for this browser instance**.
3. Leave a `https://chatgpt.com/` tab open and run `yarn start`.
4. When Chrome asks whether to allow the debugging connection, choose **Allow**.

The CLI attaches to the **already-running Chrome** using Chrome's opt-in debugging connection. It does **not** launch Chrome, open a new browser window or tab, create a separate profile, or request another login. The browser stays open when the CLI exits. You may turn remote debugging off afterward in `chrome://inspect/#remote-debugging`.

Remote debugging temporarily gives the approved local process control of your Chrome session. Only enable it when you trust the CLI and its dependencies. No API key or pasted session token is required; the short-lived access token remains in process memory and is never written to your export.

By default, archives are written to `~/ChatGPT-Data-Export` (an ordinary local directory, not automatically Google Drive). To choose another location:

```bash
yarn start --output ~/Backups/ChatGPT
```

**Try a small run first** (intentionally incomplete):

```bash
yarn start --max-conversations 25
```

When ready, rerun without `--max-conversations`. Already verified conversations will be skipped:

```bash
yarn start
```

Use `Ctrl+C` for a graceful cancellation after the current request. Rerun the same command with the same output directory to resume. Local checkpoints are atomic: data is never marked complete before it is saved.

## Commands

| Command | What it does |
| --- | --- |
| `yarn start` | Export all discoverable workspaces, conversations, Projects, and accessible account artifacts |
| `yarn start verify` | Re-hash local conversation and attachment files; report missing/corrupted data |
| `yarn start --refresh-inventory` | Refresh the remote inventory before resuming to find new conversations |
| `yarn start --max-conversations 25` | Test with a limited set; report is **partial**, never complete |
| `yarn start --no-assets` | Export conversation data without attachments; report is **partial** |
| `yarn start --concurrency 1 --delay 1500` | Reduce API pressure if ChatGPT is rate-limiting |
| `yarn test` | Build and run deterministic tests using synthetic data |

## What it captures

- Separate archives for accessible personal and Business workspaces
- Main and archived conversation history, including Project conversations and shared conversation listings
- Raw conversation data with message branches **when supplied by a full-graph endpoint**; when the modern API only serves paginated messages, every original page is saved without falsely claiming to recover omitted branches
- Project details, instructions (if supplied by ChatGPT), and accessible project files
- Discoverable uploaded and generated `file_*` attachments, saved as binary blobs with their hashes and original names recorded in `assets-index.json`
- Account artifacts for which the currently available ChatGPT web endpoint responds: legacy memories, custom instructions, settings, beta features, Library metadata, and custom GPT discovery

The tool reads the current browser session from an existing ChatGPT tab and requests data through the same authenticated browser-origin endpoints used by the ChatGPT web app. These are **undocumented** and may stop working or yield incomplete datasets. Account-level improved memory, scheduled tasks, some standalone Library objects, inaccessible files, and certain media formats have **not been verified** as fully retrievable. Every unavailable endpoint or missing file is reported, rather than declaring a full backup.

## Archive layout

```text
~/ChatGPT-Data-Export/
  report.json                            # honest overall status
  workspaces/<workspace-fingerprint>/
    inventory.json                      # complete, reusable inventory snapshot
    account/                            # account data, status and custom GPTs
    projects/<project-id>/info.json     # raw project metadata
    projects/<project-id>/assets/       # project files when accessible
    conversations/<conversation-id>/
      raw.json                          # unmodified provider data / source pages
      complete.json                     # hashes, timestamps, missing files
      assets-index.json                 # attachment availability and names
      assets/<file-id>                  # original binary bytes
    journal.jsonl                       # append-only events, no giant rewrites
    report.json                         # scope coverage, failures, verification
```

The filenames use stable IDs so renaming a conversation does not break resume. Each completed file is written to a temporary `.part` file and renamed into place. A conversation is reused only when its raw SHA-256 checksum matches the completion marker and its source update timestamp is unchanged. Partial attachments are retried independently on subsequent runs. `verify` hashes the archive without contacting ChatGPT.

**Important:** `report.status === "complete"` refers to *the available supported endpoints and requested scopes*, not a guarantee that every byte held by OpenAI is available to third-party software. Read the per-workspace `account/status.json`, `report.json` and missing-file entries.

## Design and security

- All exports are stored directly on your machine. No third-party archive or backend.
- No browser extension, pasted bearer token, extra Chrome instance, or dedicated browser profile.
- Attaches to your already-running Chrome only after you opt into remote debugging and approve the connection. Chrome stays open at the end.
- The CLI has access to your existing Chrome session while connected, so only authorize software you trust.
- Account tokens never enter the archive, journal, or logs. The CLI never reads browser cookies from disk or stores the session token.
- Limits endpoints to the ChatGPT web origin; signed asset downloads are HTTPS with constrained known OpenAI/CDN hosts and no bearer authorization header.
- Adaptive pacing and bounded retries show status and cooldowns. HTTP 429 exhaustion interrupts honestly rather than spinning forever.
- Do **not** commit or publish your archive. The exporter never creates or copies a Chrome profile.

## Known limitations in v0.1.0

This is an **initial implementation, not yet validated against a live large ChatGPT account**. Synthetic tests cover the archive/checkpoint and URL safety pieces. Private endpoint responses, especially modern memory and media, still require real-world compatibility testing. Some API scopes may report `unavailable`, and large generated assets may not have a discoverable `file_*` pointer. HTTP 429 is expected on large Business archives; wait for the cooldown and resume rather than run multiple copies. If Chrome will not connect, verify Chrome is version 144+ and remote debugging is enabled at `chrome://inspect/#remote-debugging`, then approve the connection prompt. This uses your existing default Chrome profile; if your ChatGPT tab is in a different Chrome profile, ensure the selected remote debugging session can see that tab.

This is an independent MIT project. Inspiration and endpoint research came from the documentation and code of [CodingCat AI Chat Exporter](https://github.com/nikolaylosev/ai-chat-exporter), [ChatGPT Markdown Export](https://github.com/thekester/chatgpt-export), and [ChatGPTExporter Community](https://github.com/Trojon99/ChatGPTExporter-Community). No source code is copied or required at runtime. Not affiliated with OpenAI.
