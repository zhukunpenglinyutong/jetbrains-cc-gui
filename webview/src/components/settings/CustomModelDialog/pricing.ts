import type { TFunction } from 'i18next';
import type { ModelPricing } from '../../../types/provider';

export type PricingFieldKey = keyof ModelPricing;

export interface PricingFieldConfig {
  key: PricingFieldKey;
  labelKey: string;
  shortLabelKey: string;
  placeholder: string;
}

export const PRICING_FIELDS: PricingFieldConfig[] = [
  {
    key: 'inputCostPer1M',
    labelKey: 'settings.pluginModels.pricing.inputLabel',
    shortLabelKey: 'settings.pluginModels.pricing.inputShort',
    placeholder: '3.00',
  },
  {
    key: 'outputCostPer1M',
    labelKey: 'settings.pluginModels.pricing.outputLabel',
    shortLabelKey: 'settings.pluginModels.pricing.outputShort',
    placeholder: '15.00',
  },
  {
    key: 'cacheWriteCostPer1M',
    labelKey: 'settings.pluginModels.pricing.cacheWriteLabel',
    shortLabelKey: 'settings.pluginModels.pricing.cacheWriteShort',
    placeholder: '3.75',
  },
  {
    key: 'cacheReadCostPer1M',
    labelKey: 'settings.pluginModels.pricing.cacheReadLabel',
    shortLabelKey: 'settings.pluginModels.pricing.cacheReadShort',
    placeholder: '0.30',
  },
];

export const EMPTY_PRICING_INPUTS: Record<PricingFieldKey, string> = {
  inputCostPer1M: '',
  outputCostPer1M: '',
  cacheWriteCostPer1M: '',
  cacheReadCostPer1M: '',
};

export function parsePricingInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return Number(trimmed);
}

export function isInvalidPricingValue(value: string): boolean {
  const parsed = parsePricingInput(value);
  return parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0);
}

export function hasPricing(pricing?: ModelPricing): boolean {
  return !!pricing && PRICING_FIELDS.some(({ key }) => pricing[key] !== undefined);
}

export function formatPricingValue(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

export function buildPricing(inputs: Record<PricingFieldKey, string>): ModelPricing | undefined {
  const pricing = PRICING_FIELDS.reduce<ModelPricing>((acc, { key }) => {
    const parsed = parsePricingInput(inputs[key]);
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) {
      return acc;
    }
    return {
      ...acc,
      [key]: parsed,
    };
  }, {});

  return hasPricing(pricing) ? pricing : undefined;
}

export function formatPricingSummary(pricing: ModelPricing | undefined, t: TFunction): string {
  if (!hasPricing(pricing)) {
    return '';
  }
  return PRICING_FIELDS
    .flatMap(({ key, shortLabelKey }) => {
      const value = pricing?.[key];
      return value === undefined ? [] : [`${t(shortLabelKey)} $${value}/1M`];
    })
    .join(' | ');
}
