import { CURRENT_POLICY_VERSIONS, type PolicyConsentStatus } from '@minewiki/schemas';

export function policyConsentStatus(
  termsPolicyVersion: string | null | undefined,
  privacyPolicyVersion: string | null | undefined,
): PolicyConsentStatus {
  const termsAccepted = termsPolicyVersion === CURRENT_POLICY_VERSIONS.terms.consentVersion;
  const privacyAccepted =
    privacyPolicyVersion === CURRENT_POLICY_VERSIONS.privacy.consentVersion;

  return {
    required: !termsAccepted || !privacyAccepted,
    terms: {
      currentVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
      acceptedVersion: termsPolicyVersion ?? null,
      accepted: termsAccepted,
    },
    privacy: {
      currentVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
      acceptedVersion: privacyPolicyVersion ?? null,
      accepted: privacyAccepted,
    },
  };
}
