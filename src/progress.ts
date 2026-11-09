export class Progress {
  private started = Date.now();
  private last = '';
  private timer: NodeJS.Timeout | undefined;
  private done = 0;
  private total = 0;
  private stage = 'Starting';
  private note = '';

  start(): void { this.timer = setInterval(() => this.render(), 1000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.render(true); }
  set(stage: string, done?: number, total?: number, note?: string): void {
    this.stage = stage;
    if (done !== undefined) this.done = done;
    if (total !== undefined) this.total = total;
    if (note !== undefined) this.note = note;
    this.render();
  }
  info(message: string): void { this.clear(); process.stderr.write(`\n${message}\n`); this.last = ''; this.render(); }
  private clear(): void { if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K'); }
  private render(final = false): void {
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    const rate = this.done > 0 && seconds > 0 ? this.done / seconds : 0;
    const eta = rate > 0 && this.total > 0 ? `${Math.ceil((this.total - this.done) / rate)}s ETA` : 'ETA pending';
    const count = this.total ? `${this.done}/${this.total} (${(100 * this.done / this.total).toFixed(1)}%)` : `${this.done} processed`;
    const line = `${this.stage}: ${count} | ${seconds}s | ${eta}${this.note ? ` | ${this.note}` : ''}`;
    if (line === this.last && !final) return;
    this.last = line;
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns ?? 160) - 1)}`);
    else if (final || seconds % 10 === 0) process.stderr.write(line + '\n');
    if (final && process.stderr.isTTY) process.stderr.write('\n');
  }
}
