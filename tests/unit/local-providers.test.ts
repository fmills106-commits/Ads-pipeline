import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLocalAIProvider } from '@/server/providers/local/ai';
import { createLocalImageProvider, renderCreativeSvg } from '@/server/providers/local/image';
import {
  createSimulatedAdvertisingProvider,
  resetSimulatedCampaigns,
} from '@/server/providers/local/advertising';

/**
 * The free implementations are what the $0 promise actually rests on, so they
 * are held to the same standard as a paid one would be: validated output,
 * deterministic behaviour, and — above all — never claiming to be real.
 */

describe('local AI provider', () => {
  const ai = createLocalAIProvider();

  it('is free and always available', () => {
    expect(ai.descriptor.tier).toBe('LOCAL_FREE');
    expect(ai.descriptor.isConfigured()).toBe(true);
  });

  it('reports zero cost for every call', async () => {
    const result = await ai.complete({
      task: 'business.analyse',
      instruction: 'x',
      data: { businessName: 'Alpine Coffee' },
      parse: (raw) => raw,
    });

    expect(result.usage.estimatedCostCents).toBe(0);
    expect(result.usage.actualCostCents).toBe(0);
  });

  it('produces output that passes the caller’s schema', async () => {
    // The local provider gets no exemption from validation; if it drifts out
    // of shape, this test fails rather than something downstream.
    const schema = z.object({
      simulated: z.literal(true),
      valueProposition: z.string().min(1),
      brandVoice: z.string().min(1),
      audienceHypotheses: z
        .array(z.object({ statement: z.string(), reasoning: z.string(), uncertainty: z.string() }))
        .min(1),
    });

    const result = await ai.complete({
      task: 'business.analyse',
      instruction: 'Analyse this business',
      data: { businessName: 'Harbour Marine' },
      parse: (raw) => schema.parse(raw),
    });

    expect(result.value.simulated).toBe(true);
  });

  it('marks everything it produces as simulated', async () => {
    for (const task of ['business.analyse', 'strategy.generate', 'copy.generate']) {
      const result = await ai.complete({
        task,
        instruction: 'x',
        data: { productName: 'A Thing', businessName: 'A Shop' },
        parse: (raw) => raw as { simulated: boolean },
      });
      expect(result.value.simulated, task).toBe(true);
    }
  });

  it('is deterministic — the same input always gives the same output', async () => {
    const run = async () =>
      ai.complete({
        task: 'copy.generate',
        instruction: 'x',
        data: { productName: 'Sourdough Starter' },
        parse: (raw) => raw,
      });

    expect(JSON.stringify((await run()).value)).toBe(JSON.stringify((await run()).value));
  });

  it('never invents prices, reviews, statistics or superlatives', async () => {
    const result = await ai.complete({
      task: 'copy.generate',
      instruction: 'x',
      data: { productName: 'Sourdough Starter' },
      parse: (raw) => raw as { variants: Array<Record<string, string>> },
    });

    const text = JSON.stringify(result.value).toLowerCase();
    for (const forbidden of [
      '$',
      '%',
      'best',
      '#1',
      'guarantee',
      'only 3 left',
      'limited time',
      'reviews say',
      'clinically',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('refuses a task it has no handler for rather than improvising', async () => {
    await expect(
      ai.complete({ task: 'not.a.real.task', instruction: 'x', parse: (raw) => raw }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
});

describe('local image provider', () => {
  const images = createLocalImageProvider();

  it('is free and always available', () => {
    expect(images.descriptor.tier).toBe('LOCAL_FREE');
    expect(images.descriptor.isConfigured()).toBe(true);
  });

  it('renders at the requested dimensions', async () => {
    const result = await images.generate({
      prompt: JSON.stringify({ productName: 'Sourdough Starter' }),
      width: 1080,
      height: 1350,
    });

    expect(result.value.width).toBe(1080);
    expect(result.value.height).toBe(1350);
    expect(result.value.mimeType).toBe('image/svg+xml');
    expect(result.usage.estimatedCostCents).toBe(0);
  });

  it('draws only values it was given — the price on the image is the price passed in', async () => {
    // This is what makes creative QA satisfiable by construction: the renderer
    // has no way to produce a price that contradicts the source data.
    const svg = renderCreativeSvg(
      { productName: 'Sourdough Starter', priceLabel: '$9.99', offerBadge: '20% off' },
      1080,
      1080,
    );

    expect(svg).toContain('$9.99');
    expect(svg).toContain('20% off');
    expect(svg).not.toContain('$4.99');
  });

  it('escapes product names, which come from scraped pages', async () => {
    const svg = renderCreativeSvg(
      { productName: '<script>alert(1)</script> & "quoted"' },
      600,
      600,
    );

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp;');
  });

  it('truncates a very long product name instead of overflowing', () => {
    const svg = renderCreativeSvg({ productName: 'word '.repeat(80) }, 1080, 1080);
    expect(svg).toContain('…');
  });

  it('is deterministic for the same brief', () => {
    const brief = { productName: 'Sourdough Starter', brandName: 'Alpine' };
    expect(renderCreativeSvg(brief, 1080, 1080)).toBe(renderCreativeSvg(brief, 1080, 1080));
  });

  it('produces well-formed SVG', () => {
    const svg = renderCreativeSvg({ productName: 'Thing', cta: 'Shop now' }, 1080, 1080);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});

describe('simulated advertising provider', () => {
  const ads = createSimulatedAdvertisingProvider();

  it('is free and always available', () => {
    expect(ads.descriptor.tier).toBe('LOCAL_FREE');
    expect(ads.descriptor.isConfigured()).toBe(true);
  });

  it('marks every campaign it creates as not real', async () => {
    resetSimulatedCampaigns();
    const result = await ads.createCampaign({
      name: 'Test',
      objective: 'OUTCOME_SALES',
      dailyBudgetCents: 1_000,
      startsAt: new Date(),
    });

    expect(result.value.isReal).toBe(false);
    expect(result.value.externalId).toMatch(/^sim_camp_/);
  });

  it('marks every insight it returns as not real', async () => {
    resetSimulatedCampaigns();
    const campaign = await ads.createCampaign({
      name: 'Test',
      objective: 'OUTCOME_SALES',
      dailyBudgetCents: 1_000,
      startsAt: new Date(),
    });

    const insights = await ads.getCampaignInsights(campaign.value.externalId, {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-08'),
    });

    expect(insights.value.isReal).toBe(false);
  });

  it('never simulates spending more than the campaign budget allowed', async () => {
    resetSimulatedCampaigns();
    const dailyBudgetCents = 1_000;
    const campaign = await ads.createCampaign({
      name: 'Test',
      objective: 'OUTCOME_SALES',
      dailyBudgetCents,
      startsAt: new Date(),
    });

    const days = 7;
    const insights = await ads.getCampaignInsights(campaign.value.externalId, {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-08'),
    });

    expect(insights.value.spendCents).toBeLessThanOrEqual(dailyBudgetCents * days);
    expect(insights.value.spendCents).toBeGreaterThan(0);
  });

  it('produces internally consistent metrics', async () => {
    resetSimulatedCampaigns();
    const campaign = await ads.createCampaign({
      name: 'Test',
      objective: 'OUTCOME_SALES',
      dailyBudgetCents: 2_000,
      startsAt: new Date(),
    });

    const { value } = await ads.getCampaignInsights(campaign.value.externalId, {
      from: new Date('2026-01-01'),
      to: new Date('2026-01-15'),
    });

    expect(value.clicks).toBeLessThanOrEqual(value.impressions);
    expect(value.purchases).toBeLessThanOrEqual(value.clicks);
    expect(value.purchaseValueCents).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic per campaign, so analytics can be tested against it', async () => {
    resetSimulatedCampaigns();
    const campaign = await ads.createCampaign({
      name: 'Test',
      objective: 'OUTCOME_SALES',
      dailyBudgetCents: 1_500,
      startsAt: new Date(),
    });
    const range = { from: new Date('2026-01-01'), to: new Date('2026-01-08') };

    const first = await ads.getCampaignInsights(campaign.value.externalId, range);
    const second = await ads.getCampaignInsights(campaign.value.externalId, range);

    expect(first.value).toEqual(second.value);
  });
});
