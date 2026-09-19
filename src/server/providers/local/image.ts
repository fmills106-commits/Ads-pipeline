import { createHash } from 'node:crypto';
import {
  FREE_USAGE,
  type GeneratedImage,
  type ImageGenerationProvider,
  type ImageGenerationRequest,
  type ProviderResult,
} from '../types';

/**
 * The local, free creative renderer.
 *
 * It composes an SVG from the brief — product name, offer, call to action,
 * brand colours — rather than calling a diffusion model. That is a real
 * capability, not a placeholder: template-composed creative is what most
 * ecommerce advertising actually looks like, it is exactly reproducible, it
 * renders in milliseconds, and it costs nothing.
 *
 * Because every element is placed from known values, the QA checks in Phase 4
 * are satisfiable by construction: the price on the image is the price that
 * was passed in, so it cannot contradict the source data.
 *
 * SVG is emitted rather than a raster format deliberately — no native image
 * dependency, so `npm install` stays free of build toolchains, and the output
 * is inspectable text in tests. Rasterising for upload is a Phase 4 concern.
 */

const DESCRIPTOR = {
  key: 'image.local',
  capability: 'IMAGE_GENERATION' as const,
  tier: 'LOCAL_FREE' as const,
  label: 'Built-in renderer (free)',
  description:
    'Composes ad creatives from templates on this machine. Costs nothing, and every value on the image comes from your product data.',
  priority: 0,
  isConfigured: () => true,
};

export interface CreativeBrief {
  productName: string;
  headline?: string;
  offerBadge?: string;
  cta?: string;
  priceLabel?: string;
  brandName?: string;
  primaryColor?: string;
  backgroundColor?: string;
}

/** Palette used when a business has no brand colours extracted yet. */
const FALLBACK_PALETTE = [
  { primary: '#4338ca', background: '#eef2ff' },
  { primary: '#0f766e', background: '#ecfdf5' },
  { primary: '#b45309', background: '#fffbeb' },
  { primary: '#9d174d', background: '#fdf2f8' },
] as const;

function paletteFor(seed: string): { primary: string; background: string } {
  const hash = createHash('sha256').update(seed).digest();
  return FALLBACK_PALETTE[hash.readUInt32BE(0) % FALLBACK_PALETTE.length]!;
}

/** XML escaping. Product names come from scraped pages — untrusted by default. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Crude but predictable wrapping, so long product names do not overflow. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current !== '' && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return lines;
}

export function renderCreativeSvg(brief: CreativeBrief, width: number, height: number): string {
  const palette = paletteFor(brief.brandName ?? brief.productName);
  const primary = brief.primaryColor ?? palette.primary;
  const background = brief.backgroundColor ?? palette.background;

  // Safe area: 8% inset on every edge, matching the platform specs in §45, so
  // nothing important is cropped by a placement.
  const inset = Math.round(Math.min(width, height) * 0.08);
  const contentWidth = width - inset * 2;

  const titleSize = Math.round(Math.min(width, height) * 0.085);
  const bodySize = Math.round(titleSize * 0.5);

  const headline = brief.headline ?? brief.productName;
  const headlineLines = wrap(headline, 22, 3);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(headline)}">`,
    `<rect width="${width}" height="${height}" fill="${escapeXml(background)}"/>`,
    `<rect x="0" y="0" width="${width}" height="${Math.round(height * 0.012)}" fill="${escapeXml(primary)}"/>`,
  ];

  if (brief.brandName) {
    parts.push(
      `<text x="${inset}" y="${inset + bodySize}" font-family="system-ui, sans-serif" font-size="${Math.round(bodySize * 0.8)}" font-weight="600" letter-spacing="1.5" fill="${escapeXml(primary)}">${escapeXml(brief.brandName.toUpperCase())}</text>`,
    );
  }

  let cursorY = Math.round(height * 0.42);
  for (const line of headlineLines) {
    parts.push(
      `<text x="${inset}" y="${cursorY}" font-family="system-ui, sans-serif" font-size="${titleSize}" font-weight="700" fill="#0f172a">${escapeXml(line)}</text>`,
    );
    cursorY += Math.round(titleSize * 1.15);
  }

  if (brief.priceLabel) {
    parts.push(
      `<text x="${inset}" y="${cursorY + bodySize}" font-family="system-ui, sans-serif" font-size="${Math.round(titleSize * 0.6)}" font-weight="600" fill="#0f172a">${escapeXml(brief.priceLabel)}</text>`,
    );
    cursorY += Math.round(bodySize * 2);
  }

  if (brief.offerBadge) {
    const badgeWidth = Math.min(contentWidth, brief.offerBadge.length * bodySize * 0.72 + inset);
    const badgeHeight = Math.round(bodySize * 2.1);
    const badgeY = inset;
    const badgeX = width - inset - badgeWidth;
    parts.push(
      `<rect x="${badgeX}" y="${badgeY}" width="${Math.round(badgeWidth)}" height="${badgeHeight}" rx="${Math.round(badgeHeight / 2)}" fill="${escapeXml(primary)}"/>`,
      `<text x="${Math.round(badgeX + badgeWidth / 2)}" y="${badgeY + Math.round(badgeHeight * 0.66)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${bodySize}" font-weight="700" fill="#ffffff">${escapeXml(brief.offerBadge)}</text>`,
    );
  }

  if (brief.cta) {
    const ctaHeight = Math.round(bodySize * 2.6);
    const ctaWidth = Math.min(contentWidth, brief.cta.length * bodySize * 0.78 + inset * 1.5);
    const ctaY = height - inset - ctaHeight;
    parts.push(
      `<rect x="${inset}" y="${ctaY}" width="${Math.round(ctaWidth)}" height="${ctaHeight}" rx="${Math.round(ctaHeight * 0.22)}" fill="${escapeXml(primary)}"/>`,
      `<text x="${Math.round(inset + ctaWidth / 2)}" y="${ctaY + Math.round(ctaHeight * 0.64)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${bodySize}" font-weight="600" fill="#ffffff">${escapeXml(brief.cta)}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

class LocalImageProvider implements ImageGenerationProvider {
  readonly descriptor = DESCRIPTOR;

  async generate(request: ImageGenerationRequest): Promise<ProviderResult<GeneratedImage>> {
    // The "prompt" for the local renderer is a JSON creative brief, so every
    // value drawn on the image is one the caller verified.
    const brief = parseBrief(request.prompt);
    const svg = renderCreativeSvg(brief, request.width, request.height);
    const bytes = Buffer.from(svg, 'utf8');

    return {
      value: {
        bytes,
        mimeType: 'image/svg+xml',
        width: request.width,
        height: request.height,
      },
      usage: FREE_USAGE(1, 'images'),
    };
  }
}

function parseBrief(prompt: string): CreativeBrief {
  try {
    const parsed: unknown = JSON.parse(prompt);
    if (parsed && typeof parsed === 'object' && 'productName' in parsed) {
      return parsed as CreativeBrief;
    }
  } catch {
    // Fall through: a plain string is treated as the product name.
  }
  return { productName: prompt.slice(0, 120) };
}

export const createLocalImageProvider = (): ImageGenerationProvider => new LocalImageProvider();
export const localImageDescriptor = DESCRIPTOR;
