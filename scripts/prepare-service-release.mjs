import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareServiceRelease } from './service-release-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = await prepareServiceRelease(repoRoot);
console.log(`Prepared immutable service release ${manifest.releaseKey} (api, worker, bot).`);
