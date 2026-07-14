import assert from 'node:assert/strict';
import test from 'node:test';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';
import { policyConsentStatus } from './policy-consent';

test('current policy versions allow normal session use', () => {
  const status = policyConsentStatus(
    CURRENT_POLICY_VERSIONS.terms.consentVersion,
    CURRENT_POLICY_VERSIONS.privacy.consentVersion,
  );
  assert.equal(status.required, false);
  assert.equal(status.terms.accepted, true);
  assert.equal(status.privacy.accepted, true);
});

test('missing or outdated policy versions require consent', () => {
  const status = policyConsentStatus('outdated-terms', null);
  assert.equal(status.required, true);
  assert.equal(status.terms.accepted, false);
  assert.equal(status.terms.acceptedVersion, 'outdated-terms');
  assert.equal(status.privacy.accepted, false);
  assert.equal(status.privacy.acceptedVersion, null);
});
