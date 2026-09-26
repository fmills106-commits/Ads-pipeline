import type { ProviderCapability, ProviderTier } from '@prisma/client';
import type { ProviderSecrets } from './credentials';

/**
 * The provider system.
 *
 * Every capability that *could* cost money sits behind one of these. The
 * contract that makes the zero-cost guarantee real is not a convention — it is
 * this type:
 *
 *   - every capability has at least one `LOCAL_FREE` implementation, so the
 *     application is fully functional with every external service disabled;
 *   - an `EXTERNAL_PAID` implementation is unreachable unless three
 *     independent switches are all set (zero-cost mode off, a non-zero cost
 *     ceiling, and that specific provider enabled for the workspace);
 *   - nothing calls a provider directly. Calls go through `runProvider`, which
 *     checks ceilings first and records the cost after, so a paid call that
 *     leaves no trace is not expressible.
 */

export type { ProviderCapability, ProviderTier };

/** Registry key, e.g. `ai.local`. Namespaced by capability so it reads well in logs. */
export type ProviderKey = string;

export interface ProviderDescriptor {
  key: ProviderKey;
  capability: ProviderCapability;
  tier: ProviderTier;
  /** Shown in Settings. Plain language — the owner reads this. */
  label: string;
  /** One sentence on what changes if this is used. */
  description: string;
  /**
   * Priority when several providers for a capability are available and
   * enabled. Higher wins. Free providers sit at 0; a paid provider a merchant
   * has deliberately enabled outranks it.
   */
  priority: number;
  /**
   * Whether the credentials this provider needs exist — an API key, a bucket.
   * `false` means it cannot be selected however it is enabled.
   *
   * Takes the credentials rather than reading the environment itself, because a
   * key can now come from the environment *or* from the workspace that will be
   * billed for it. A descriptor that read `process.env` directly could only ever
   * see the operator's key and would report a workspace's own key as missing.
   */
  isConfigured: (secrets: ProviderSecrets) => boolean;
  /**
   * Whether an implementation actually exists behind this key.
   *
   * A descriptor is registered before its adapter is written, so the interface
   * can honestly list what is coming. `false` means the factory throws, and
   * such a provider must never be selected — the alternative, discovered the
   * moment a paid switch existed, is an owner turning one on and every AI
   * action failing from then on.
   *
   * Absent means implemented. Only the placeholders say otherwise.
   */
  implemented?: boolean;
}

/**
 * What a provider reports about an invocation, so cost can be recorded.
 *
 * A `LOCAL_FREE` provider returns zeros. That is not a formality: recording
 * free calls is what lets the dashboard say "1,284 AI calls this month, $0.00",
 * which is the single most useful fact about running in zero-cost mode.
 */
export interface ProviderUsage {
  units: number;
  unitLabel: string;
  /** Predicted before the call, checked against ceilings. Zero for free tiers. */
  estimatedCostCents: number;
  /** Reported by the provider afterwards. Null when genuinely unknown — never guessed. */
  actualCostCents: number | null;
  model?: string;
}

export const FREE_USAGE = (units: number, unitLabel: string): ProviderUsage => ({
  units,
  unitLabel,
  estimatedCostCents: 0,
  actualCostCents: 0,
});

/** Every provider implementation carries its descriptor. */
export interface Provider {
  readonly descriptor: ProviderDescriptor;
}

/** Result of one invocation: the value, plus what it cost. */
export interface ProviderResult<T> {
  value: T;
  usage: ProviderUsage;
}

// ---------------------------------------------------------------------------
// Capability interfaces
// ---------------------------------------------------------------------------
// Declared together so the seams the platform commits to are visible in one
// place. Implementations land with the phase that needs them; each capability
// gets its local, free implementation first.

/**
 * Fetching a public web page.
 *
 * Behind a provider because a site protected by bot mitigation may eventually
 * need a paid fetching service — and when that day comes, the scanner should
 * not change. The free implementation is plain HTTP and is always available.
 */
export interface WebFetchProvider extends Provider {
  fetch(request: WebFetchRequest): Promise<ProviderResult<FetchedResource>>;
}

export interface WebFetchRequest {
  url: string;
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedResource {
  /** The normalised URL that was requested. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  bytes: number;
  /** True when the byte ceiling cut the body short. */
  truncated: boolean;
  redirectChain: string[];
  /** Set when the body was deliberately not read. */
  skippedReason?: 'unsupported-content-type' | 'too-large';
}

export interface AIProvider extends Provider {
  /**
   * Produces structured output conforming to the caller's schema.
   *
   * Deliberately narrow: one method, structured in and structured out. The
   * marketing engine never asks a provider for prose — it asks for a shape it
   * can validate, which is what makes swapping providers safe.
   */
  complete<T>(request: AICompletionRequest<T>): Promise<ProviderResult<T>>;
}

export interface AICompletionRequest<T> {
  /** What this call is for, e.g. `business.analyse`. Used for cost attribution. */
  task: string;
  /** Application instruction. Trusted. */
  instruction: string;
  /**
   * Untrusted input — scraped page text, product descriptions. Passed
   * separately from `instruction` so it can be delimited as data and never
   * interpreted as instruction.
   */
  data?: Record<string, string>;
  /** Validates the response. Malformed output never reaches the caller. */
  parse: (raw: unknown) => T;
  maxOutputTokens?: number;
  /**
   * JSON Schema describing what `parse` will accept.
   *
   * Optional, and a provider may ignore it — the local one does, since it
   * builds its output from the shape rather than the other way round. A
   * provider talking to a real model uses it to constrain generation, which
   * matters for cost as much as for quality: an unusable response is a billed
   * call, and the repair is a second one.
   *
   * Derived from the caller's schema rather than written by hand, so it cannot
   * drift away from what validation actually requires.
   */
  outputSchema?: Record<string, unknown>;
}

export interface ImageGenerationProvider extends Provider {
  generate(request: ImageGenerationRequest): Promise<ProviderResult<GeneratedImage>>;
}

export interface ImageGenerationRequest {
  prompt: string;
  width: number;
  height: number;
  /** Product photography and brand assets to compose with, as storage keys. */
  sourceAssetKeys?: string[];
  seed?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export interface AdvertisingProvider extends Provider {
  listAdAccounts(): Promise<ProviderResult<AdAccount[]>>;
  createCampaign(input: CampaignInput): Promise<ProviderResult<ExternalRef>>;
  pauseCampaign(externalId: string): Promise<ProviderResult<void>>;
  resumeCampaign(externalId: string): Promise<ProviderResult<void>>;
  getCampaignInsights(externalId: string, range: DateRange): Promise<ProviderResult<Insights>>;
}

export interface AdAccount {
  externalId: string;
  name: string;
  currency: string;
}

export interface CampaignInput {
  name: string;
  objective: string;
  dailyBudgetCents: number;
  startsAt: Date;
  endsAt?: Date;
}

export interface ExternalRef {
  externalId: string;
  /** False for simulated campaigns — surfaced in the UI, never hidden. */
  isReal: boolean;
}

export interface DateRange {
  from: Date;
  to: Date;
}

export interface Insights {
  impressions: number;
  clicks: number;
  spendCents: number;
  purchases: number;
  purchaseValueCents: number;
  /** False when these numbers are simulated. */
  isReal: boolean;
}

export interface StorageProvider extends Provider {
  put(key: string, bytes: Buffer, mimeType: string): Promise<ProviderResult<StoredObject>>;
  get(key: string): Promise<ProviderResult<Buffer>>;
  delete(key: string): Promise<ProviderResult<void>>;
  /** A URL the browser can load. For local storage, an app-served route. */
  urlFor(key: string): string;
}

export interface StoredObject {
  key: string;
  bytes: number;
  mimeType: string;
}
