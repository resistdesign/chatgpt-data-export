import type { ProgressSnapshot } from '../progress.js';

interface UiState {
  signedIn: boolean;
  output: string;
  running: boolean;
  activity: 'idle' | 'exporting' | 'recovering' | 'verifying';
  status: string;
  error: string | null;
  progress: ProgressSnapshot | null;
  result: string | null;
  events: string[];
  archive: {
    workspaces: number; discovered: number; recordedComplete: number; recordedPartial: number;
    notYetCaptured: number; missingFiles: number; projects: number;
    projectFilesMissing: number; projectsWithMissing: number;
    lastRunAt: string | null; lastRunStatus: string | null; verified: false;
    blockers: Record<string, number>;
    routeFailures: Array<{
      kind: 'conversation' | 'project'; route: string;
      scope: 'workspace header' | 'default scope'; result: string; attempts: number;
    }>;
  } | null;
  archiveLoading: boolean;
  archiveError: string | null;
  fileObservation: {
    active: boolean;
    requests: Array<{
      route: string; method: 'GET' | 'POST' | 'other';
      queryKeys: string[]; otherQueryKeys: number; status: string;
      booleans?: { inline?: boolean; download_intent?: boolean };
      headerNames?: string[];
    }>;
  };
}
interface AppBridge {
  state(): Promise<UiState>;
  signIn(): Promise<boolean>;
  checkSession(): Promise<boolean>;
  chooseOutput(): Promise<string>;
  start(limit: 25 | null): Promise<boolean>;
  recover(): Promise<boolean>;
  copyDiagnostics(): Promise<boolean>;
  observeFile(): Promise<boolean>;
  verify(): Promise<boolean>;
  stop(): Promise<boolean>;
  openOutput(): Promise<boolean>;
  closeSignIn(): Promise<boolean>;
  onState(callback: (state: UiState) => void): () => void;
}
declare global { interface Window { chatgptExporter: AppBridge } }
const app = window.chatgptExporter;
function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element ${id}`);
  return node;
}
const text = (id: string, value: string): void => { el(id).textContent = value; };
const button = (id: string, run: () => Promise<unknown>): void => {
  el(id).addEventListener('click', () => { void run().catch(err => { text('summary', err instanceof Error ? err.message : String(err)); el('summary').classList.add('error'); }); });
};
const duration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};
function render(state: UiState): void {
  const conn = el('connection-state');
  conn.textContent = state.signedIn ? 'Connected' : 'Not signed in';
  conn.className = `pill ${state.signedIn ? 'good' : 'muted'}`;
  text('output', state.output);
  el('output').title = state.output;
  const saved = state.archive;
  text('archive-overview', state.archiveLoading ? 'Reading saved checkpoints…'
    : state.archiveError ? `Archive inspection failed: ${state.archiveError}`
    : saved
      ? `${saved.recordedComplete.toLocaleString()} complete · ${saved.recordedPartial.toLocaleString()} partial · ${saved.notYetCaptured.toLocaleString()} not yet captured out of ${saved.discovered.toLocaleString()} discovered conversations`
      : 'No saved archive in this folder yet.');
  text('archive-missing', saved
    ? `${saved.missingFiles.toLocaleString()} missing file references, including ${saved.projectFilesMissing.toLocaleString()} across ${saved.projectsWithMissing}/${saved.projects} Projects. Counts are from saved checkpoints, not hash verification.`
    : 'A small export will create a local inventory and resumable checkpoints.');
  text('archive-blockers', saved
    ? Object.entries(saved.blockers).filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}: ${count}`).join(' · ')
    : '');
  text('archive-routes', saved && saved.routeFailures.length > 0
    ? 'Most frequent failed routes (attempts, not files): ' +
      saved.routeFailures.slice(0, 4)
        .map(item => `${item.route} [${item.scope}]: ${item.result} ×${item.attempts}`).join(' · ')
    : 'No per-route diagnostics recorded yet.');
  const observe = el('observe-file') as HTMLButtonElement;
  observe.disabled = state.running;
  observe.textContent = state.fileObservation.active ? 'Stop observing download' : 'Observe one ChatGPT download';
  const observed = state.fileObservation.requests;
  text('observation-status', state.fileObservation.active
    ? `Observing this app's ChatGPT window. ${observed.length} file requests captured. Click a Project file's Download control in ChatGPT, then stop observing.`
    : observed.length
      ? `${observed.length} sanitized file API responses captured. Use Copy safe diagnostic summary to share the results.`
      : 'Optional: observe a real Project download in the app-owned ChatGPT window to identify the correct API route. Only route shapes and HTTP statuses are collected.');
  (el('copy-diagnostics') as HTMLButtonElement).disabled = state.running ||
    state.archiveLoading || !saved || saved.missingFiles === 0;
  (el('retry-missing') as HTMLButtonElement).disabled = state.running || !state.signedIn ||
    state.archiveLoading || !saved || saved.missingFiles === 0;
  text('stage', state.status);
  const progress = state.progress;
  text('counter', progress?.total
    ? `${progress.done.toLocaleString()}/${progress.total.toLocaleString()} processed`
    : state.running ? 'Working…' : '—');
  (el('progress-bar') as HTMLElement).style.width = progress?.total ? `${Math.max(0, Math.min(100, 100 * progress.done / progress.total))}%` : '0%';
  text('detail', progress ? [progress.stage, progress.note].filter(Boolean).join(' · ') : 'No export running');
  text('elapsed', progress
    ? `${duration(progress.seconds)} total · ${duration(progress.stageSeconds)} in this stage${state.running && progress.total > 0 ? (progress.etaSeconds === null ? ' · remaining unknown' : ' · about ' + duration(progress.etaSeconds) + ' left') : ''}`
    : '—');
  const counts = progress?.capture;
  el('capture-metrics').hidden = !counts;
  if (counts) {
    text('capture-complete', counts.complete.toLocaleString());
    text('capture-partial', counts.partial.toLocaleString());
    text('capture-failed', counts.failed.toLocaleString());
    text('capture-reused', counts.reused.toLocaleString());
    text('capture-active', counts.active.toLocaleString());
  }
  text('pacing', state.running ? (progress?.waiting ?? '') : '');
  el('pacing').hidden = !state.running || !progress?.waiting;
  text('summary', state.error ?? state.result ?? (state.running ? 'Archive operation in progress…' : 'No archive result yet.'));
  el('summary').classList.toggle('error', Boolean(state.error));
  for (const id of ['export-all','test-25']) (el(id) as HTMLButtonElement).disabled = state.running || !state.signedIn;
  (el('stop') as HTMLButtonElement).disabled = !state.running ||
    (state.activity !== 'exporting' && state.activity !== 'recovering');
  for (const id of ['verify','choose-output']) (el(id) as HTMLButtonElement).disabled = state.running;
  (el('check-session') as HTMLButtonElement).disabled = state.running;
  text('activity-count', `${state.events.length} updates`);
  const log = el('log');
  log.replaceChildren(...(state.events.length ? state.events : ['No activity yet.']).map(s => {
    const entry = document.createElement('div'); entry.className = 'line'; entry.textContent = s; return entry;
  }));
  log.scrollTop = log.scrollHeight;
}
button('sign-in', () => app.signIn());
button('check-session', () => app.checkSession());
button('close-sign-in', () => app.closeSignIn());
button('choose-output', () => app.chooseOutput());
button('export-all', () => app.start(null));
button('test-25', () => app.start(25));
button('retry-missing', () => app.recover());
button('copy-diagnostics', () => app.copyDiagnostics());
button('observe-file', () => app.observeFile());
button('stop', () => app.stop());
button('verify', () => app.verify());
button('open-output', () => app.openOutput());
app.onState(render);
void app.state().then(render).catch(err => { text('summary', err instanceof Error ? err.message : String(err)); });
