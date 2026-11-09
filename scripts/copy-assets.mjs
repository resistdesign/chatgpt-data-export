import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/desktop/ui', { recursive: true });
await cp('src/desktop/ui', 'dist/desktop/ui', { recursive: true, force: true });
await cp('src/desktop/preload.cjs', 'dist/desktop/preload.cjs');
