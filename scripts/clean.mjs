import { rm } from 'node:fs/promises';
// Only compiled output is removed. Local export data never lives here.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
