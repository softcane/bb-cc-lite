import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pricingCachePath } from "./paths.js";
import type { TokenUsage } from "./types.js";

export interface ModelPrice {
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheCreationInputTokenCost?: number;
  cacheReadInputTokenCost?: number;
}

export interface PricingTable {
  fetchedAt?: string;
  models: Record<string, ModelPrice>;
}

const FALLBACK_PRICING: PricingTable = {
  fetchedAt: "bundled",
  models: {
    "claude-3-5-sonnet": {
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
      cacheCreationInputTokenCost: 3.75 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000
    },
    "claude-3-7-sonnet": {
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
      cacheCreationInputTokenCost: 3.75 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000
    },
    "claude-sonnet-4": {
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
      cacheCreationInputTokenCost: 3.75 / 1_000_000,
      cacheReadInputTokenCost: 0.3 / 1_000_000
    },
    "claude-opus-4": {
      inputCostPerToken: 15 / 1_000_000,
      outputCostPerToken: 75 / 1_000_000,
      cacheCreationInputTokenCost: 18.75 / 1_000_000,
      cacheReadInputTokenCost: 1.5 / 1_000_000
    },
    "claude-3-opus": {
      inputCostPerToken: 15 / 1_000_000,
      outputCostPerToken: 75 / 1_000_000,
      cacheCreationInputTokenCost: 18.75 / 1_000_000,
      cacheReadInputTokenCost: 1.5 / 1_000_000
    },
    "claude-3-haiku": {
      inputCostPerToken: 0.25 / 1_000_000,
      outputCostPerToken: 1.25 / 1_000_000,
      cacheCreationInputTokenCost: 0.3 / 1_000_000,
      cacheReadInputTokenCost: 0.03 / 1_000_000
    }
  }
};

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export async function loadPricing(cachePath = pricingCachePath()): Promise<PricingTable> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as PricingTable;
    if (parsed.models && typeof parsed.models === "object") {
      return parsed;
    }
  } catch {
    // Fall back to bundled prices.
  }
  return FALLBACK_PRICING;
}

export async function refreshPricing(cachePath = pricingCachePath()): Promise<PricingTable> {
  const response = await fetch(LITELLM_PRICING_URL);
  if (!response.ok) {
    throw new Error(`LiteLLM pricing fetch failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as Record<string, Record<string, unknown>>;
  const models: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(raw)) {
    models[model] = {
      inputCostPerToken: numberValue(value.input_cost_per_token),
      outputCostPerToken: numberValue(value.output_cost_per_token),
      cacheCreationInputTokenCost: numberValue(value.cache_creation_input_token_cost),
      cacheReadInputTokenCost: numberValue(value.cache_read_input_token_cost)
    };
  }
  const table: PricingTable = { fetchedAt: new Date().toISOString(), models };
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  await writeFile(cachePath, `${JSON.stringify(table, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(cachePath, 0o600);
  return table;
}

export function estimateCostUsd(modelId: string | undefined, usage: TokenUsage, pricing: PricingTable): number | undefined {
  if (!modelId) {
    return undefined;
  }
  const price = findModelPrice(modelId, pricing);
  if (!price) {
    return undefined;
  }
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const cacheCreation = usage.cacheCreationInputTokens || 0;
  const cacheRead = usage.cacheReadInputTokens || 0;
  const total =
    input * (price.inputCostPerToken || 0) +
    output * (price.outputCostPerToken || 0) +
    cacheCreation * (price.cacheCreationInputTokenCost || price.inputCostPerToken || 0) +
    cacheRead * (price.cacheReadInputTokenCost || 0);
  return total > 0 ? total : undefined;
}

function findModelPrice(modelId: string, pricing: PricingTable): ModelPrice | undefined {
  const normalized = modelId.toLowerCase();
  if (pricing.models[modelId]) {
    return pricing.models[modelId];
  }
  const exact = Object.entries(pricing.models).find(([key]) => normalized === key.toLowerCase());
  if (exact) {
    return exact[1];
  }
  return Object.entries(pricing.models).find(([key]) => normalized.includes(key.toLowerCase()))?.[1];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
