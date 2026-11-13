export interface CaptureProgress {
  /** Finished attempts, including saved, partial, and failed conversations. */
  attempted: number;
  /** Fully saved conversations; includes verified checkpoints reused from earlier runs. */
  complete: number;
  partial: number;
  failed: number;
  reused: number;
  active: number;
}

export interface AttachmentSyncProgress {
  /** Missing references eligible for this run (previously unavailable excluded). */
  eligible: number;
  attempted: number;
  recovered: number;
  alreadyVerified: number;
  unavailable: number;
  unlisted: number;
  missingSource: number;
  previouslyUnavailable: number;
}

export interface ProgressSnapshot {
  stage: string;
  done: number;
  total: number;
  /** Total elapsed time for this run. */
  seconds: number;
  /** Elapsed time since the current stage began. */
  stageSeconds: number;
  /** Estimate omitted for stages with unpredictable attachment retries. */
  etaSeconds: number | null;
  note: string;
  waiting?: string;
  capture?: CaptureProgress;
  attachments?: AttachmentSyncProgress;
  message?: string;
}

/** The same status stream feeds both terminal users and the Electron dashboard. */
export class Progress {
  private started = Date.now();
  private stageStarted = this.started;
  private last = '';
  private timer: NodeJS.Timeout | undefined;
  private done = 0;
  private total = 0;
  private stage = 'Starting';
  private note = '';
  private capture: CaptureProgress | undefined;
  private attachments: AttachmentSyncProgress | undefined;
  private waitingMessage: string | undefined;
  private waitingUntil = 0;

  constructor(private readonly onUpdate?: (state: ProgressSnapshot) => void, private readonly terminal = true) {}

  start(): void { this.timer = setInterval(() => this.render(), 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.render(true); }
  set(
    stage: string, done?: number, total?: number, note?: string,
    capture?: CaptureProgress, attachments?: AttachmentSyncProgress,
  ): void {
    if (stage !== this.stage) {
      this.done = 0;
      this.total = 0;
      this.note = '';
      this.capture = undefined;
      this.attachments = undefined;
      this.stageStarted = Date.now();
    }
    this.stage = stage;
    if (done !== undefined) this.done = done;
    if (total !== undefined) this.total = total;
    if (note !== undefined) this.note = note;
    if (capture !== undefined) this.capture = { ...capture };
    if (attachments !== undefined) this.attachments = { ...attachments };
    this.render();
  }
  /** Request pacing is transient; never replace the actual progress note. */
  waiting(note: string): void {
    this.waitingMessage = note;
    this.waitingUntil = Date.now() + 1800;
    this.render();
  }
  info(message: string): void {
    if (this.terminal) { this.clear(); process.stderr.write(`\n${message}\n`); this.last = ''; }
    this.render(false, message);
  }
  private clear(): void { if (this.terminal && process.stderr.isTTY) process.stderr.write('\r\x1b[2K'); }
  private render(final = false, message?: string): void {
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    const stageSeconds = Math.floor((Date.now() - this.stageStarted) / 1000);
    // Project/file retry cost varies wildly. An ETA extrapolated from saved
    // checkpoints or earlier stages can be wrong by tens of minutes.
    const variableDuration = this.stage === 'Capturing' || this.stage === 'Saving Project files' ||
      this.stage === 'Recovering missing files' || this.stage === 'Syncing attachments';
    const rate = stageSeconds >= 10 && this.done >= 3 ? this.done / stageSeconds : 0;
    const etaSeconds = !variableDuration && rate > 0 && this.total > 0
      ? Math.ceil(Math.max(0, this.total - this.done) / rate) : null;
    const waiting = this.waitingUntil > Date.now() ? this.waitingMessage : undefined;
    const state: ProgressSnapshot = {
      stage: this.stage, done: this.done, total: this.total, seconds,
      stageSeconds, etaSeconds, note: this.note,
      ...(waiting ? { waiting } : {}),
      ...(this.capture ? { capture: { ...this.capture } } : {}),
      ...(this.attachments ? { attachments: { ...this.attachments } } : {}),
      ...(message ? { message } : {}),
    };
    this.onUpdate?.(state);
    if (!this.terminal) return;
    const eta = etaSeconds === null ? 'remaining time unknown' : `${etaSeconds}s estimated remaining`;
    const count = this.total ? `${this.done}/${this.total} processed` : `${this.done} processed`;
    const line = `${this.stage}: ${count} | ${seconds}s total / ${stageSeconds}s stage | ${eta}${this.note ? ` | ${this.note}` : ''}${waiting ? ` | ${waiting}` : ''}`;
    if (line === this.last && !final) return;
    this.last = line;
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns ?? 160) - 1)}`);
    else if (final || seconds % 10 === 0) process.stderr.write(line + '\n');
    if (final && process.stderr.isTTY) process.stderr.write('\n');
  }
}
