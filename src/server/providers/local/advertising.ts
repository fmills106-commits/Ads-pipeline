import { createHash, randomUUID } from 'node:crypto';
import {
  FREE_USAGE,
  type AdAccount,
  type AdvertisingProvider,
  type CampaignInput,
  type DateRange,
  type ExternalRef,
  type Insights,
  type ProviderResult,
} from '../types';

/**
 * The simulated advertising provider.
 *
 * Campaigns created here have full structure — objective, budget, schedule,
 * ad sets, ads — and produce plausible day-by-day performance data, but no ad
 * is ever served and no money is ever spent.
 *
 * Every value it returns carries `isReal: false`, and the UI is required to
 * surface that. A simulated campaign that looked real would be the single most
 * damaging thing this product could do, so the flag is part of the return type
 * rather than a convention.
 *
 * The simulation is deterministic per campaign: the same campaign always
 * produces the same numbers, so experiment logic and analytics can be tested
 * against a stable, reproducible dataset.
 */

const DESCRIPTOR = {
  key: 'advertising.simulated',
  capability: 'ADVERTISING' as const,
  tier: 'LOCAL_FREE' as const,
  label: 'Simulated advertising (free)',
  description:
    'Builds complete campaigns and generates realistic performance data without contacting an ad platform. No ads are served and no money is spent.',
  priority: 0,
  isConfigured: () => true,
};

/** Deterministic unit float in [0,1) from a seed and a label. */
function seeded(seed: string, label: string): number {
  const hash = createHash('sha256').update(`${seed}:${label}`).digest();
  return hash.readUInt32BE(0) / 0x1_0000_0000;
}

const campaigns = new Map<string, CampaignInput & { pausedAt: Date | null }>();

class SimulatedAdvertisingProvider implements AdvertisingProvider {
  readonly descriptor = DESCRIPTOR;

  async listAdAccounts(): Promise<ProviderResult<AdAccount[]>> {
    return {
      value: [{ externalId: 'sim_act_000000', name: 'Simulated Ad Account', currency: 'USD' }],
      usage: FREE_USAGE(1, 'calls'),
    };
  }

  async createCampaign(input: CampaignInput): Promise<ProviderResult<ExternalRef>> {
    const externalId = `sim_camp_${randomUUID().slice(0, 12)}`;
    campaigns.set(externalId, { ...input, pausedAt: null });

    return {
      value: { externalId, isReal: false },
      usage: FREE_USAGE(1, 'calls'),
    };
  }

  async pauseCampaign(externalId: string): Promise<ProviderResult<void>> {
    const campaign = campaigns.get(externalId);
    if (campaign) campaign.pausedAt = new Date();
    return { value: undefined, usage: FREE_USAGE(1, 'calls') };
  }

  async resumeCampaign(externalId: string): Promise<ProviderResult<void>> {
    const campaign = campaigns.get(externalId);
    if (campaign) campaign.pausedAt = null;
    return { value: undefined, usage: FREE_USAGE(1, 'calls') };
  }

  async getCampaignInsights(
    externalId: string,
    range: DateRange,
  ): Promise<ProviderResult<Insights>> {
    const campaign = campaigns.get(externalId);
    const dailyBudgetCents = campaign?.dailyBudgetCents ?? 1_000;

    const days = Math.max(
      1,
      Math.ceil((range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000)),
    );

    // Anchored on the budget so the simulation stays internally consistent:
    // spend never exceeds what the campaign was allowed, which is also the
    // invariant the real safeguards enforce.
    const utilisation = 0.75 + seeded(externalId, 'utilisation') * 0.24;
    const spendCents = Math.round(dailyBudgetCents * days * utilisation);

    // Plausible ecommerce ranges, varied per campaign but stable for it.
    const cpmCents = 400 + Math.round(seeded(externalId, 'cpm') * 900);
    const impressions = Math.max(1, Math.round((spendCents / cpmCents) * 1_000));
    const ctr = 0.008 + seeded(externalId, 'ctr') * 0.022;
    const clicks = Math.round(impressions * ctr);
    const conversionRate = 0.01 + seeded(externalId, 'cvr') * 0.04;
    const purchases = Math.round(clicks * conversionRate);
    const averageOrderCents = 2_000 + Math.round(seeded(externalId, 'aov') * 6_000);

    return {
      value: {
        impressions,
        clicks,
        spendCents,
        purchases,
        purchaseValueCents: purchases * averageOrderCents,
        isReal: false,
      },
      usage: FREE_USAGE(1, 'calls'),
    };
  }
}

export const createSimulatedAdvertisingProvider = (): AdvertisingProvider =>
  new SimulatedAdvertisingProvider();
export const simulatedAdvertisingDescriptor = DESCRIPTOR;

/** Test-only: forget every simulated campaign. */
export const resetSimulatedCampaigns = (): void => campaigns.clear();
