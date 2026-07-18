import { Injectable } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import {
  BILLING_PRODUCTS,
  billingProductForLayout,
  type BillingProduct,
} from '@minewiki/schemas/billing-contract';

export const PADDLE_BILLABLE_LAYOUT_KEYS = BILLING_PRODUCTS.map((product) => product.layoutKey);

export type PaddleBillableLayoutKey = (typeof PADDLE_BILLABLE_LAYOUT_KEYS)[number];
export type BillableServerWikiLayout = PaddleBillableLayoutKey;

const PRICE_CONFIG_KEYS = {
  handbook: 'PADDLE_PRICE_HANDBOOK',
  brand: 'PADDLE_PRICE_BRAND',
} as const;

export function billingCatalogEntry(
  config: ConfigService,
  layoutKey: BillableServerWikiLayout,
): Readonly<{ layoutKey: BillableServerWikiLayout; priceId: string }> {
  if (config.get('PADDLE_MODE', 'off') !== 'live') {
    throw new Error('Paddle billing is not live.');
  }
  return Object.freeze({
    layoutKey,
    priceId: config.get(PRICE_CONFIG_KEYS[layoutKey]),
  });
}

@Injectable()
export class BillingCatalog {
  private readonly priceByLayout: ReadonlyMap<PaddleBillableLayoutKey, string>;
  private readonly layoutByPrice: ReadonlyMap<string, PaddleBillableLayoutKey>;

  constructor(private readonly config: ConfigService) {
    const entries = this.config.get('PADDLE_MODE', 'off') === 'live'
      ? PADDLE_BILLABLE_LAYOUT_KEYS.map((layoutKey) => [
          layoutKey,
          billingCatalogEntry(this.config, layoutKey).priceId,
        ] as const)
      : [];
    this.priceByLayout = new Map(entries);
    this.layoutByPrice = new Map(entries.map(([layoutKey, priceId]) => [priceId, layoutKey]));
  }

  isLive(): boolean {
    return this.config.get('PADDLE_MODE', 'off') === 'live';
  }

  listBillableLayouts(): readonly PaddleBillableLayoutKey[] {
    return PADDLE_BILLABLE_LAYOUT_KEYS;
  }

  getProduct(layoutKey: PaddleBillableLayoutKey): BillingProduct {
    const product = billingProductForLayout(layoutKey);
    if (!product) throw new Error(`Unknown Paddle billing product: ${layoutKey}`);
    return product;
  }

  getProviderPriceId(layoutKey: PaddleBillableLayoutKey): string {
    const priceId = this.priceByLayout.get(layoutKey);
    if (!priceId) {
      throw new Error('Paddle billing is not live.');
    }
    return priceId;
  }

  findLayoutByProviderPriceId(priceId: string): PaddleBillableLayoutKey | null {
    return this.layoutByPrice.get(priceId) ?? null;
  }
}
