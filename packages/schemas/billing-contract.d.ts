export const BILLING_POLICY_VERSION: '2026-07-19-v2.0';
export const BILLING_POLICY_EFFECTIVE_DATE: '2026-07-19';
export const BILLING_POLICY_PATH: '/policies/billing';

export type BillingProduct = Readonly<{
  productCode: 'server_wiki_handbook' | 'server_wiki_brand';
  layoutKey: 'handbook' | 'brand';
  displayName: 'Handbook' | 'Brand';
  serviceScope: 'recurring_server_wiki_layout';
}>;

export const BILLING_PRODUCTS: readonly BillingProduct[];
export function billingProductForLayout(layoutKey: string): BillingProduct | null;
