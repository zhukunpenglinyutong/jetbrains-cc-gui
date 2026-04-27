/**
 * Shared icon component that renders the correct vendor icon based on
 * provider ID and/or model ID.
 *
 * Replaces the duplicated ProviderIcon switch statements across:
 * - ModelSelect.tsx
 * - ProviderSelect.tsx
 * - BlinkingLogo/index.tsx
 * - HistoryView.tsx
 */
import Claude from '@lobehub/icons/es/Claude';
import OpenAI from '@lobehub/icons/es/OpenAI';
import Gemini from '@lobehub/icons/es/Gemini';
import Qwen from '@lobehub/icons/es/Qwen';
import DeepSeek from '@lobehub/icons/es/DeepSeek';
import Kimi from '@lobehub/icons/es/Kimi';
import Moonshot from '@lobehub/icons/es/Moonshot';
import Zhipu from '@lobehub/icons/es/Zhipu';
import Minimax from '@lobehub/icons/es/Minimax';
import Doubao from '@lobehub/icons/es/Doubao';
import Spark from '@lobehub/icons/es/Spark';
import Hunyuan from '@lobehub/icons/es/Hunyuan';
import Baichuan from '@lobehub/icons/es/Baichuan';
import Mistral from '@lobehub/icons/es/Mistral';
import Meta from '@lobehub/icons/es/Meta';
import Cohere from '@lobehub/icons/es/Cohere';
import Grok from '@lobehub/icons/es/Grok';
import OpenRouter from '@lobehub/icons/es/OpenRouter';
import Yi from '@lobehub/icons/es/Yi';
import type { ReactElement } from 'react';
import { resolveIconVendor, type ModelVendor } from '../../utils/modelIconMapping';

export interface ProviderModelIconProps {
  /** Provider type: claude, codex, gemini, etc. */
  providerId?: string;
  /** Model ID for vendor-specific icon resolution (e.g. "qwen3.5-plus") */
  modelId?: string;
  /** Icon size in pixels */
  size?: number;
  /** Whether to use colored variant (true) or avatar/mono variant (false) */
  colored?: boolean;
}

/**
 * Icon renderers for each vendor.
 * Returns [coloredVersion, avatarVersion] JSX elements.
 *
 * Note: Some icons (OpenRouter, Moonshot, Grok, OpenAI) do not have a .Color
 * sub-component, so we use .Avatar for both variants.
 */
const VENDOR_ICON_MAP: Record<
  ModelVendor,
  (size: number, colored: boolean) => ReactElement
> = {
  claude: (size, colored) =>
    colored ? <Claude.Color size={size} /> : <Claude.Avatar size={size} />,
  openai: (size, _colored) =>
    <OpenAI.Avatar size={size} />,
  gemini: (size, colored) =>
    colored ? <Gemini.Color size={size} /> : <Gemini.Avatar size={size} />,
  qwen: (size, colored) =>
    colored ? <Qwen.Color size={size} /> : <Qwen.Avatar size={size} />,
  deepseek: (size, colored) =>
    colored ? <DeepSeek.Color size={size} /> : <DeepSeek.Avatar size={size} />,
  kimi: (size, colored) =>
    colored ? <Kimi.Color size={size} /> : <Kimi.Avatar size={size} />,
  moonshot: (size, _colored) =>
    <Moonshot.Avatar size={size} />,
  zhipu: (size, colored) =>
    colored ? <Zhipu.Color size={size} /> : <Zhipu.Avatar size={size} />,
  minimax: (size, colored) =>
    colored ? <Minimax.Color size={size} /> : <Minimax.Avatar size={size} />,
  doubao: (size, colored) =>
    colored ? <Doubao.Color size={size} /> : <Doubao.Avatar size={size} />,
  spark: (size, colored) =>
    colored ? <Spark.Color size={size} /> : <Spark.Avatar size={size} />,
  hunyuan: (size, colored) =>
    colored ? <Hunyuan.Color size={size} /> : <Hunyuan.Avatar size={size} />,
  baichuan: (size, colored) =>
    colored ? <Baichuan.Color size={size} /> : <Baichuan.Avatar size={size} />,
  mistral: (size, colored) =>
    colored ? <Mistral.Color size={size} /> : <Mistral.Avatar size={size} />,
  meta: (size, colored) =>
    colored ? <Meta.Color size={size} /> : <Meta.Avatar size={size} />,
  cohere: (size, colored) =>
    colored ? <Cohere.Color size={size} /> : <Cohere.Avatar size={size} />,
  grok: (size, _colored) =>
    <Grok.Avatar size={size} />,
  openrouter: (size, _colored) =>
    <OpenRouter.Avatar size={size} />,
  yi: (size, colored) =>
    colored ? <Yi.Color size={size} /> : <Yi.Avatar size={size} />,
};

/**
 * Renders the appropriate vendor icon based on provider and model context.
 *
 * Resolution priority:
 * 1. modelId pattern match (most specific)
 * 2. providerId lookup
 * 3. Claude default
 */
export const ProviderModelIcon = ({
  providerId,
  modelId,
  size = 16,
  colored = false,
}: ProviderModelIconProps) => {
  const vendor = resolveIconVendor(providerId, modelId);
  const renderer = VENDOR_ICON_MAP[vendor];
  return renderer(size, colored);
};
