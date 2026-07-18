import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import claimMethods from '../../../packages/schemas/claim-methods.js';

const workflowUrl = new URL('../components/claim/claim-workflow.tsx', import.meta.url);
const tombstoneUrl = new URL('../../api/src/claim/plugin-claim.controller.ts', import.meta.url);

test('claim UI renders exactly the shared supported methods without plugin callback advertising', async () => {
  const source = await readFile(workflowUrl, 'utf8');
  const optionsBlock = source.slice(
    source.indexOf('const METHOD_OPTIONS'),
    source.indexOf('const NOTE_COPY'),
  );
  const renderedMethods = [...optionsBlock.matchAll(/method: '([^']+)'/gu)].map((match) => match[1]);

  assert.deepEqual(renderedMethods, [...claimMethods.SUPPORTED_CLAIM_METHODS]);
  assert.match(source, /SUPPORTED_CLAIM_METHODS/u);
  assert.doesNotMatch(source, /pluginCallbackEndpoint|plugin_callback|selectedMethod === 'plugin'|\/plugin\/claim\/complete/u);
});

test('legacy plugin claim endpoint remains an explicit 410 tombstone', async () => {
  const source = await readFile(tombstoneUrl, 'utf8');

  assert.match(source, /GoneException/u);
  assert.match(source, /Plugin ownership verification is disabled/u);
});
