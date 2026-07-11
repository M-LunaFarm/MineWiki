import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

const customFile = process.env.MINEWIKI_ENV_FILE?.trim();
const candidates = [
  ...(customFile ? [customFile] : []),
  '.env.local',
  '.env',
];

for (const candidate of candidates) {
  const absolutePath = path.resolve(process.cwd(), candidate);
  if (!existsSync(absolutePath)) {
    continue;
  }
  loadDotenv({ path: absolutePath, override: false });
}
