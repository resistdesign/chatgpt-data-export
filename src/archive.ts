import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const safeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error('Unsafe archive identifier');
  return id;
};
export const workspaceKey = (id: string): string => sha256('chatgpt-workspace-v1\0' + id).slice(0, 24);

export interface SavedFile { path: string; sha256: string; bytes: number }
export interface CompletionMarker {
  schema: 1;
  id: string;
  updated: string | number | null;
  raw: SavedFile;
  files: SavedFile[];
  missing: Array<{ id: string; reason: string }>;
  completedAt: string;
}

export class Archive {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  path(relative: string): string {
    if (relative.startsWith('/') || relative.split('/').some(x => x === '..' || x === '.' || x === '')) throw new Error('Unsafe archive path');
    return join(this.root, relative);
  }
  async read<T>(relative: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(relative), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async fileHash(relative: string): Promise<string | undefined> {
    try {
      await stat(this.path(relative));
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.path(relative))) hash.update(chunk);
      return hash.digest('hex');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async atomic(relative: string, bytes: string | Uint8Array): Promise<SavedFile> {
    const file = this.path(relative);
    const tmp = `${file}.${randomUUID()}.part`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
    } finally { await rm(tmp, { force: true }).catch(() => undefined); }
    return { path: relative, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
  }
  async stream(relative: string, body: ReadableStream<Uint8Array>): Promise<SavedFile> {
    const file = this.path(relative);
    const tmp = `${file}.${randomUUID()}.part`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      await pipeline(Readable.fromWeb(body as never), createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
      const hash = await this.fileHashRelativeAbsolute(tmp);
      const size = (await stat(tmp)).size;
      await rename(tmp, file);
      return { path: relative, sha256: hash, bytes: size };
    } finally { await rm(tmp, { force: true }).catch(() => undefined); }
  }
  private async fileHashRelativeAbsolute(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  }
  async json(relative: string, value: unknown): Promise<SavedFile> {
    return this.atomic(relative, JSON.stringify(value, null, 2) + '\n');
  }
  async journal(workspace: string, entry: Record<string, unknown>): Promise<void> {
    const file = this.path(`workspaces/${safeId(workspace)}/journal.jsonl`);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  }
  async verified(file: SavedFile): Promise<boolean> {
    return (await this.fileHash(file.path)) === file.sha256;
  }
  async marker(workspace: string, id: string): Promise<CompletionMarker | undefined> {
    return this.read<CompletionMarker>(`workspaces/${safeId(workspace)}/conversations/${safeId(id)}/complete.json`);
  }
  async canSkip(workspace: string, id: string, updated: string | number | null, assetsRequested: boolean): Promise<boolean> {
    const marker = await this.marker(workspace, id);
    if (!marker || marker.schema !== 1 || marker.id !== id || marker.updated !== updated || !await this.verified(marker.raw)) return false;
    if (assetsRequested && (marker.missing.length || !(await Promise.all(marker.files.map(file => this.verified(file)))).every(Boolean))) return false;
    return true;
  }
  async verifyWorkspace(
    workspace: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ expected: number; complete: number; partial: number; failed: string[]; otherMissing: string[] }> {
    const scope = `workspaces/${safeId(workspace)}`;
    const index = await this.read<{ conversations?: Array<{ id: string }> }>(`${scope}/inventory.json`);
    if (!index?.conversations) throw new Error(`No inventory for workspace ${workspace}`);
    let complete = 0;
    let partial = 0;
    const failed: string[] = [];
    const otherMissing: string[] = [];
    let checked = 0;
    onProgress?.(0, index.conversations.length);
    for (const conversation of index.conversations) {
      const marker = await this.marker(workspace, conversation.id);
      if (!marker || !await this.verified(marker.raw)) failed.push(conversation.id);
      else if (marker.missing.length || !(await Promise.all(marker.files.map(f => this.verified(f)))).every(Boolean)) partial++;
      else complete++;
      checked++;
      if (checked % 25 === 0 || checked === index.conversations.length) {
        onProgress?.(checked, index.conversations.length);
      }
    }
    const manifests = [`${scope}/account/manifest.json`, ...((index as { projects?: Array<{ id: string }> }).projects ?? []).map(p => `${scope}/projects/${safeId(p.id)}/manifest.json`)];
    for (const path of manifests) {
      const manifest = await this.read<{ files?: SavedFile[] }>(path);
      if (!Array.isArray(manifest?.files)) { otherMissing.push(path); continue; }
      for (const file of manifest.files) if (!await this.verified(file)) otherMissing.push(file.path);
    }
    return { expected: index.conversations.length, complete, partial, failed, otherMissing };
  }
}
