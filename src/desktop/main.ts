import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ElectronSessionClient } from '../electron-client.js';
import { exportAll, verifyArchive, type ExportOptions } from '../exporter.js';
import { SessionExpiredError, SessionCheckError, ExportCancelledError } from '../errors.js';
import { Progress, type ProgressSnapshot } from '../progress.js';
import { inspectArchive, archiveDiagnosticText, missingProjectFilePairs, findMissingProjectExample, recoverMissingAssets, type ArchiveOverview } from '../recovery.js';
import { syncMissingAttachments } from '../attachment-sync.js';
import { summarizeFileRequest, formatObservedRequests, safeRequestHeaderNames, matchesMissingProjectFile, type ObservedFileRequest } from './request-observer.js';

const here = dirname(fileURLToPath(import.meta.url));
const PARTITION = 'persist:chatgpt-data-export';
const CHATGPT = 'https://chatgpt.com/';

interface UiState {
  signedIn: boolean;
  output: string;
  running: boolean;
  activity: 'idle' | 'exporting' | 'recovering' | 'syncing-assets' | 'verifying';
  status: string;
  error: string | null;
  progress: ProgressSnapshot | null;
  result: string | null;
  events: string[];
  archive: ArchiveOverview | null;
  archiveLoading: boolean;
  archiveError: string | null;
  fileObservation: { active: boolean; requests: ObservedFileRequest[]; example: { projectName: string; fileName: string } | null };
}

const state: UiState = {
  signedIn: false, output: join(homedir(), 'ChatGPT-Data-Export'), running: false,
  activity: 'idle', status: 'Ready to connect', error: null, progress: null, result: null, events: [],
  archive: null, archiveLoading: true, archiveError: null,
  fileObservation: { active: false, requests: [], example: null },
};
let dashboard: BrowserWindow | null = null;
let signInWindow: BrowserWindow | null = null;
let current: { api: ElectronSessionClient; cancelled: boolean } | null = null;
let quitRequested = false;
/** Only header NAMES. Never preserve header values. */
const observedHeaderNames = new Map<number, string[]>();

function broadcast(): void {
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('export:state', structuredClone(state));
}
function event(message: string): void {
  state.events = [...state.events, `${new Date().toLocaleTimeString()}  ${message}`].slice(-100);
  broadcast();
}
function description(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Reads saved metadata only. No authentication, network access or file hashing. */
async function refreshArchiveOverview(): Promise<void> {
  const output = state.output;
  state.archiveLoading = true;
  state.archiveError = null;
  broadcast();
  try {
    const overview = await inspectArchive(output);
    if (state.output === output) state.archive = overview;
  } catch (error) {
    if (state.output === output) {
      state.archive = null;
      state.archiveError = description(error);
    }
  } finally {
    if (state.output === output) {
      state.archiveLoading = false;
      broadcast();
    }
  }
}
function ensureDashboard(e: IpcMainInvokeEvent): void {
  if (!dashboard || e.sender !== dashboard.webContents || e.senderFrame?.url !== dashboard.webContents.getURL()) {
    throw new Error('Untrusted dashboard IPC request');
  }
}
function startJob(activity: UiState['activity'], status: string): void {
  if (state.running) throw new Error('An archive operation is already running');
  state.running = true;
  state.activity = activity;
  state.status = status;
  state.error = null;
  state.result = null;
  state.progress = null;
  broadcast();
}
function finishJob(): void {
  current = null;
  state.running = false;
  state.activity = 'idle';
  broadcast();
  if (quitRequested) app.quit();
}

async function authenticate(): Promise<boolean> {
  const client = new ElectronSessionClient(session.fromPartition(PARTITION));
  state.signedIn = await client.authenticated();
  if (!state.running && (state.status === 'Ready to connect' || state.status === 'Ready to export or recover')) {
    state.status = state.signedIn ? 'Ready to export or recover' : 'Ready to connect';
  }
  broadcast();
  return state.signedIn;
}

/**
 * Opt-in observation of only the authenticated ChatGPT window's file API calls.
 * Uses Electron's own Session; never requests, stores or forwards credentials,
 * file names, IDs, URLs, response bodies, or request/response headers.
 */
function stopFileObservation(): void {
  if (!state.fileObservation.active) return;
  const observer = session.fromPartition(PARTITION).webRequest;
  observer.onCompleted(null);
  observer.onBeforeSendHeaders(null);
  observedHeaderNames.clear();
  state.fileObservation.active = false;
  event(`Download observation stopped: ${state.fileObservation.requests.length} sanitized file API responses.`);
}
async function toggleFileObservation(): Promise<void> {
  if (state.running) throw new Error('Finish the archive operation before observing a download');
  if (state.fileObservation.active) {
    stopFileObservation();
    return;
  }
  const [missingPairs, example] = await Promise.all([
    missingProjectFilePairs(state.output), findMissingProjectExample(state.output),
  ]);
  state.fileObservation = {
    active: true, requests: [],
    example: example ? { projectName: example.projectName, fileName: example.fileName } : null,
  };
  const filter = { urls: ['https://chatgpt.com/backend-api/*'] };
  const network = session.fromPartition(PARTITION).webRequest;
  observedHeaderNames.clear();
  network.onBeforeSendHeaders(filter, (details, callback) => {
    const signIn = signInWindow;
    if (state.fileObservation.active && signIn && !signIn.isDestroyed() &&
      details.webContentsId === signIn.webContents.id) {
      // Copy only allowlisted header names, NEVER values.
      const names = safeRequestHeaderNames(details.requestHeaders);
      if (names.length) observedHeaderNames.set(details.id, names);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  network.onCompleted(filter, details => {
    const names = observedHeaderNames.get(details.id) ?? [];
    observedHeaderNames.delete(details.id);
    const signIn = signInWindow;
    if (!state.fileObservation.active || !signIn || signIn.isDestroyed() ||
      details.webContentsId !== signIn.webContents.id) return;
    const item = summarizeFileRequest(details.url, details.statusCode, details.method, names);
    if (!item) return;
    const match = matchesMissingProjectFile(details.url, missingPairs);
    const safeItem = match === undefined ? item : {
      ...item, matchesArchivedMissingProjectFile: match,
    };
    state.fileObservation.requests = [...state.fileObservation.requests, safeItem].slice(-30);
    broadcast();
  });
  openSignIn(example ? `https://chatgpt.com/g/${encodeURIComponent(example.projectId)}` : CHATGPT);
  event('Observe mode enabled. Try downloading the Project attachment named in the dashboard; only redacted request details are retained.');
}

function isHttps(input: string): boolean {
  try { return new URL(input).protocol === 'https:'; } catch { return false; }
}
function openSignIn(targetUrl = CHATGPT): void {
  if (signInWindow && !signInWindow.isDestroyed()) {
    signInWindow.focus();
    if (targetUrl !== CHATGPT) void signInWindow.loadURL(targetUrl)
      .catch(err => { event(`Could not open selected Project: ${description(err)}`); });
    return;
  }
  const win = new BrowserWindow({
    title: 'Sign in to ChatGPT', width: 1040, height: 850, minWidth: 600, minHeight: 520,
    show: true, backgroundColor: '#141821',
    webPreferences: {
      partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true,
    },
  });
  signInWindow = win;
  win.webContents.on('will-navigate', (e, url) => { if (!isHttps(url)) e.preventDefault(); });
  // OAuth sometimes opens separate windows. Child windows inherit the same persistent session
  // but never acquire Node.js, a preload bridge, or access to local archive files.
  win.webContents.setWindowOpenHandler(({ url }) => isHttps(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { width: 720, height: 790, webPreferences: { partition: PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true } } }
    : { action: 'deny' });
  const refresh = (): void => { void authenticate().then(ok => { if (ok) event('Signed in to ChatGPT. This app will retain its session between launches.'); }); };
  win.webContents.on('did-finish-load', refresh);
  win.on('closed', () => { stopFileObservation(); signInWindow = null; void authenticate(); });
  void win.loadURL(targetUrl).catch(err => { event(`Sign-in page failed to load: ${description(err)}`); });
}

async function saveSettings(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  await writeFile(join(app.getPath('userData'), 'settings.json'), JSON.stringify({ output: state.output }), { mode: 0o600 });
}
async function loadSettings(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')) as { output?: unknown };
    if (typeof raw.output === 'string' && raw.output.trim()) state.output = resolve(raw.output);
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') event('Could not read saved output preferences; using default.'); }
}

function createDashboard(): void {
  dashboard = new BrowserWindow({
    title: 'ChatGPT Data Export', width: 980, height: 820, minWidth: 740, minHeight: 630,
    backgroundColor: '#101319',
    webPreferences: {
      preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true,
    },
  });
  dashboard.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dashboard.webContents.on('will-navigate', e => e.preventDefault());
  dashboard.webContents.on('did-finish-load', broadcast);
  dashboard.on('closed', () => { dashboard = null; });
  void dashboard.loadFile(join(here, 'ui', 'index.html'));
}

async function runExport(limit: 25 | null, historyFirst = false, incremental = false): Promise<void> {
  startJob('exporting', incremental ? 'Syncing new and updated conversations (attachments deferred)'
    : historyFirst ? 'Backing up conversations first (attachments deferred)'
    : limit === null ? 'Exporting everything including files'
      : 'Testing 25 conversations + up to 3 Projects per workspace');
  const progress = new Progress(snapshot => { state.progress = snapshot; if (snapshot.message) event(snapshot.message); else broadcast(); }, false);
  const client = new ElectronSessionClient(session.fromPartition(PARTITION), 750, progress);
  const job = { api: client, cancelled: false };
  current = job;
  progress.start();
  try {
    if (!await client.authenticated()) throw new Error('ChatGPT sign-in is required. Use the Sign in button, then try again.');
    const options: ExportOptions = {
      output: state.output, concurrency: 2,
      max: limit === null ? undefined : limit,
      assets: !historyFirst,
      // Normal resume uses existing inventory. Quick sync checks recent
      // listings and merges changes, without re-enumerating all 4,133 chats.
      refresh: false,
      sync: incremental,
    };
    const report = await exportAll(client, options, progress, () => job.cancelled);
    state.status = incremental ? 'Recent conversation sync finished'
      : report.status === 'complete' ? 'Export completed'
      : report.status === 'cancelled' ? 'Export stopped'
      : 'Export finished with incomplete coverage';
    const changes = report.reports.reduce<{ new: number; updated: number }>((total, item) => {
      const sync = item.incrementalSync as { new?: number; updated?: number } | undefined;
      return { new: total.new + (sync?.new ?? 0), updated: total.updated + (sync?.updated ?? 0) };
    }, { new: 0, updated: 0 });
    const wasQuickSync = report.reports.some(item => Boolean(item.incrementalSync));
    state.result = incremental
      ? wasQuickSync
        ? `Sync finished: ${changes.new} new and ${changes.updated} updated conversations discovered. Existing archive preserved; attachments deferred.`
        : 'Initial inventory and conversation backup completed; future runs can sync only recent changes.'
      : `Export ${report.status}. Review report.json before treating the archive as complete.`;
    event(state.result);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      state.signedIn = false;
      state.status = 'ChatGPT sign-in expired; saved data is intact';
      state.error = 'Your ChatGPT session needs to be renewed. Open ChatGPT sign-in, then resume the export.';
    } else if (err instanceof SessionCheckError) {
      state.status = 'Could not verify ChatGPT session; export paused';
      state.error = description(err);
    } else {
      state.status = job.cancelled ? 'Export stopped; checkpoints retained' : 'Export interrupted';
      state.error = description(err);
    }
    event(`Export interrupted: ${state.error}. Verified checkpoints remain on disk; restart to resume.`);
  } finally { progress.stop(); finishJob(); void refreshArchiveOverview(); }
}

/** A bounded local-checkpoint recovery pass; does not re-fetch the conversation list. */
async function runAttachmentSync(): Promise<void> {
  startJob('syncing-assets', 'Syncing missing attachments from saved references');
  const progress = new Progress(snapshot => {
    state.progress = snapshot;
    if (snapshot.message) event(snapshot.message);
    else broadcast();
  }, false);
  const client = new ElectronSessionClient(session.fromPartition(PARTITION), 750, progress);
  const job = { api: client, cancelled: false };
  current = job;
  progress.start();
  try {
    if (!await client.authenticated()) throw new Error('Sign in to ChatGPT before syncing attachments.');
    const result = await syncMissingAttachments(client, state.output, progress, () => job.cancelled);
    state.status = 'Attachment sync pass finished';
    state.result = `${result.recovered} attachments recovered (${result.alreadyVerified} already on disk); ${result.unavailable} newly unavailable; ${result.previouslyUnavailable} previously denied and skipped; ${result.unlisted} unmatched; ${result.remaining} missing references remain.`;
    event(state.result);
  } catch (error) {
    if (job.cancelled || error instanceof ExportCancelledError) {
      state.status = 'Attachment sync stopped safely';
      state.error = null;
      state.result = 'Attachment sync stopped. Every completed file checkpoint is retained; resume using the same button.';
      event(state.result);
    } else if (error instanceof SessionExpiredError) {
      state.signedIn = false;
      state.status = 'ChatGPT login expired; archive intact';
      state.error = 'Sign into ChatGPT again, then resume attachment sync.';
      event(state.error);
    } else {
      state.status = 'Attachment sync interrupted; archive intact';
      state.error = description(error);
      event('Attachment sync interrupted; saved file checkpoints remain. Retry later from the same archive.');
    }
  } finally {
    progress.stop();
    finishJob();
    void refreshArchiveOverview();
  }
}

async function runRecovery(): Promise<void> {
  startJob('recovering', 'Recovering up to 10 missing files');
  const progress = new Progress(snapshot => {
    state.progress = snapshot;
    if (snapshot.message) event(snapshot.message);
    else broadcast();
  }, false);
  const client = new ElectronSessionClient(session.fromPartition(PARTITION), 750, progress);
  const job = { api: client, cancelled: false };
  current = job;
  progress.start();
  try {
    if (!await client.authenticated()) throw new Error('Sign in to ChatGPT before recovering files.');
    const result = await recoverMissingAssets(client, state.output, progress, () => job.cancelled, 10);
    state.status = job.cancelled ? 'Recovery stopped; saved data retained' : 'Missing-file recovery pass finished';
    state.result = result.selected
      ? `${result.selected} selected, ${result.attempted} actually attempted, ${result.unlisted} absent from saved source metadata, ${result.recovered} recovered. ${result.remainingInArchive} missing file references remain.`
      : 'No missing files can be retried for the signed-in workspace.';
    event(state.result);
  } catch (error) {
    if (job.cancelled || error instanceof ExportCancelledError) {
      state.status = 'Recovery stopped; saved data retained';
      state.error = null;
      state.result = 'Recovery stopped. Previously saved checkpoints are still available.';
      event(state.result);
    } else if (error instanceof SessionExpiredError) {
      state.signedIn = false;
      state.status = 'ChatGPT sign-in expired; saved data retained';
      state.error = 'Sign in to ChatGPT again, then resume recovery.';
      event(state.error);
    } else {
      state.status = 'Recovery interrupted';
      state.error = description(error);
      event(`Recovery interrupted: ${state.error}. Existing checkpoints were not removed.`);
    }
  } finally { progress.stop(); finishJob(); void refreshArchiveOverview(); }
}

async function runVerify(): Promise<void> {
  startJob('verifying', 'Verifying stored data');
  try {
    const results = await verifyArchive(state.output);
    const issues = results.reduce((n, item) => n + item.partial + item.failed.length + item.otherMissing.length, 0);
    state.status = issues ? 'Verification found missing or partial data' : 'All inventoried files verified';
    state.result = `${results.reduce((n, item) => n + item.complete, 0)} conversations verified. ${issues} partial, missing or corrupt entries across ${results.length} workspace(s).`;
    event(state.result);
  } catch (err) { state.status = 'Verification failed'; state.error = description(err); event(`Verification error: ${description(err)}`); }
  finally { finishJob(); }
}

async function initialize(): Promise<void> {
  app.setName('ChatGPT Data Export');
  await app.whenReady();
  const signedInSession = session.fromPartition(PARTITION);
  signedInSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await loadSettings();
  ipcMain.handle('app:state', e => { ensureDashboard(e); return structuredClone(state); });
  ipcMain.handle('app:sign-in', e => { ensureDashboard(e); openSignIn(); return true; });
  ipcMain.handle('app:check-session', async e => { ensureDashboard(e); return authenticate(); });
  ipcMain.handle('app:choose-output', async e => {
    ensureDashboard(e);
    if (state.running) return state.output;
    const result = await dialog.showOpenDialog(dashboard!, { title: 'Choose an export directory', defaultPath: state.output, properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      state.output = resolve(result.filePaths[0]);
      await saveSettings();
      broadcast();
      void refreshArchiveOverview();
    }
    return state.output;
  });
  ipcMain.handle('app:start', (e, limit: unknown) => {
    ensureDashboard(e);
    if (limit !== null && limit !== 25 && limit !== 'history' && limit !== 'sync') throw new Error('Invalid export mode');
    if (state.running) throw new Error('An archive operation is already running');
    void runExport(limit === 'history' || limit === 'sync' ? null : limit,
      limit === 'history' || limit === 'sync', limit === 'sync');
    return true;
  });
  ipcMain.handle('app:verify', e => { ensureDashboard(e); if (state.running) throw new Error('Archive is busy'); void runVerify(); return true; });
  ipcMain.handle('app:copy-diagnostics', async e => {
    ensureDashboard(e);
    if (state.running) throw new Error('Cannot copy diagnostics while modifying archive');
    const diagnostic = await archiveDiagnosticText(state.output);
    const observed = state.fileObservation.requests;
    const observedSection = observed.length
      ? '\n\nObserved real ChatGPT file API responses (no URLs or values):\n' + formatObservedRequests(observed).join('\n')
      : '';
    clipboard.writeText(diagnostic + observedSection);
    event('Safe diagnostics copied: archive failures, observed route shapes, boolean flags, and header names only.');
    return true;
  });
  ipcMain.handle('app:observe-file', async e => {
    ensureDashboard(e);
    await toggleFileObservation();
    return true;
  });
  ipcMain.handle('app:sync-assets', e => {
    ensureDashboard(e);
    if (state.running) throw new Error('Archive is busy');
    if (!state.signedIn || !state.archive || state.archive.missingFiles === 0) {
      throw new Error('Sign in and select an archive with missing attachments first.');
    }
    void runAttachmentSync();
    return true;
  });
  ipcMain.handle('app:recover', e => {
    ensureDashboard(e);
    if (state.running) throw new Error('Archive is busy');
    if (!state.signedIn || !state.archive || state.archive.missingFiles === 0) {
      throw new Error('Sign in and select an archive with missing files first.');
    }
    void runRecovery();
    return true;
  });
  ipcMain.handle('app:stop', e => { ensureDashboard(e); if (current && state.running) { current.cancelled = true; current.api.cancel(); state.status = 'Stopping after current safe checkpoint'; event('Stop requested. Already saved files are retained.'); } return true; });
  ipcMain.handle('app:open-output', async e => { ensureDashboard(e); await mkdir(state.output, { recursive: true }); const message = await shell.openPath(state.output); if (message) throw new Error(message); return true; });
  ipcMain.handle('app:close-sign-in', e => { ensureDashboard(e); signInWindow?.close(); return true; });
  createDashboard();
  await authenticate();
  void refreshArchiveOverview();
}

app.on('before-quit', e => {
  stopFileObservation();
  if (state.running && !quitRequested) {
    e.preventDefault();
    quitRequested = true;
    if (current) { current.cancelled = true; current.api.cancel(); }
    state.status = 'Stopping export safely before exiting';
    broadcast();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!dashboard) createDashboard(); });
void initialize().catch(err => { console.error('ChatGPT Data Export could not start:', err); app.quit(); });
