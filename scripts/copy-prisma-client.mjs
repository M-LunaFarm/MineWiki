#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [sourceArgument, destinationArgument] = process.argv.slice(2);

if (!sourceArgument || !destinationArgument) {
  throw new Error('Usage: copy-prisma-client.mjs <source-package-root> <destination-package-root>');
}

function resolveGeneratedClient(packageRoot) {
  const packageJson = join(resolve(packageRoot), 'package.json');
  const packageRequire = createRequire(packageJson);
  const clientEntry = packageRequire.resolve('@prisma/client');
  const packageNodeModules = dirname(dirname(dirname(clientEntry)));
  return join(packageNodeModules, '.prisma', 'client');
}

const source = resolveGeneratedClient(sourceArgument);
const destination = resolveGeneratedClient(destinationArgument);

if (!existsSync(join(source, 'default.js'))) {
  throw new Error(`Generated Prisma client was not found at ${source}`);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true });
