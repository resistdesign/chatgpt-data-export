export interface ProgressSnapshot {
  stage: string;
  done: number;
  total: number;
  seconds: number;
  etaSeconds: number | null;
  note: string;
  message?: string;
}

/** The same status stream feeds both terminal users and the Electron dashboard. */
export class Progress {
  private started = Date.now();
  private last = '';
  private timer: NodeJS.Timeout | undefined;
  private done = 0;
  private total = 0;
  private stage = 'Starting';
  private note = '';

  constructor(private readonly onUpdate?: (state: ProgressSnapshot) => void, private readonly terminal = true) {}

  start(): void { this.timer = setInterval(() => this.render(), 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.render(true); }
  set(stage: string, done?: number, total?: number, note?: string): void {
    if (stage !== this.stage) { this.done = 0; this.total = 0; this.note = ''; }
    this.stage = stage;
    if (done !== undefined) this.done = done;
    if (total !== undefined) this.total = total;
    if (note !== undefined) this.note = note;
    this.render();
  }
  /** Update the visible note without erasing the real conversation counters. */
  waiting(note: string): void { this.note = note; this.render(); }
  info(message: string): void {
    if (this.terminal) { this.clear(); process.stderr.write(`\n${message}\n`); this.last = ''; }
    this.render(false, message);
  }
  private clear(): void { if (this.terminal && process.stderr.isTTY) process.stderr.write('\r\x1b[2K'); }
  private render(final = false, message?: string): void {
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    const rate = this.done > 0 && seconds > 0 ? this.done / seconds : 0;
    const etaSeconds = rate > 0 && this.total > 0 ? Math.ceil(Math.max(0, this.total - this.done) / rate) : null;
    const state: ProgressSnapshot = { stage: this.stage, done: this.done, total: this.total, seconds, etaSeconds, note: this.note, ...(message ? { message } : {}) };
    this.onUpdate?.(state);
    if (!this.terminal) return;
    const eta = etaSeconds === null ? 'ETA pending' : `${etaSeconds}s ETA`;
    const count = this.total ? `${this.done}/${this.total} (${(100 * this.done / this.total).toFixed(1)}%)` : `${this.done} processed`;
    const line = `${this.stage}: ${count} | ${seconds}s | ${eta}${this.note ? ` | ${this.note}` : ''}`;
    if (line === this.last && !final) return;
    this.last = line;
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns ?? 160) - 1)}`);
    else if (final || seconds % 10 === 0) process.stderr.write(line + '\n');
    if (final && process.stderr.isTTY) process.stderr.write('\n');
  }
}
