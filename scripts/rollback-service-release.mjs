import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollbackServiceRelease } from './service-release-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await rollbackServiceRelease(repoRoot);
console.log(`Rolled back service release to ${result.current}; ${result.previous} is now the forward target.`);
console.log('Restart minewiki-api, minewiki-worker, and minewiki-bot to activate the selected release.');
