/**
 * Price parsing.
 *
 * Getting this wrong is expensive in a specific way: a price extracted from a
 * product page ends up printed on an advertisement. `1.299,00 €` read as
 * `$1.29` would be a misleading advert, which is exactly what §44 forbids.
 *
 * So the rule throughout is **refuse rather than guess**. An ambiguous
 * separator returns null and the price is simply not treated as verified.
 */

export interface ParsedPrice {
  cents: number;
  currency: string | null;
}

/** Currency symbols and codes seen on real storefronts. */
const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  '₹': 'INR',
  '₽': 'RUB',
  '₩': 'KRW',
  '₪': 'ILS',
  '₺': 'TRY',
  R$: 'BRL',
  C$: 'CAD',
  A$: 'AUD',
  NZ$: 'NZD',
  CHF: 'CHF',
  kr: 'SEK',
  zł: 'PLN',
};

const ISO_CODE = /\b([A-Z]{3})\b/;

/** Zero-decimal currencies, where "1000" means 1000 units, not 10.00. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);

/**
 * Parses a numeric price string into minor units.
 *
 * Handles both separator conventions by inference:
 *   `1,299.00` → last separator is `.` with 2 digits → decimal point
 *   `1.299,00` → last separator is `,` with 2 digits → decimal comma
 *   `1,299`    → 3 digits after → thousands separator
 *   `12,99`    → 2 digits after a single `,` → decimal comma (European)
 *
 * Returns null when it cannot tell, which is the important case.
 */
export function parsePriceNumber(raw: string, currency?: string | null): number | null {
  const cleaned = raw.replace(/[^\d.,\s' ]/g, '').replace(/[\s' ]/g, '');
  if (cleaned === '') return null;
  if (!/\d/.test(cleaned)) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let integerPart: string;
  let fractionPart = '';

  if (lastComma === -1 && lastDot === -1) {
    integerPart = cleaned;
  } else {
    const decimalIndex = Math.max(lastComma, lastDot);
    const afterCount = cleaned.length - decimalIndex - 1;
    const separator = cleaned[decimalIndex]!;
    const others = cleaned.slice(0, decimalIndex);

    // A second occurrence of the *same* separator means it groups thousands.
    const sameSeparatorEarlier = others.includes(separator);

    if (
      afterCount === 3 &&
      (sameSeparatorEarlier || !others.includes(separator === ',' ? '.' : ','))
    ) {
      // `1,299` / `1.299` — grouping, no decimals.
      integerPart = cleaned.replace(/[.,]/g, '');
    } else if (afterCount === 1 || afterCount === 2) {
      integerPart = others.replace(/[.,]/g, '');
      fractionPart = cleaned.slice(decimalIndex + 1);
    } else {
      // 0 or 4+ digits after the separator: not a price shape we recognise.
      return null;
    }
  }

  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fractionPart)) return null;
  if (integerPart === '' && fractionPart === '') return null;

  const units = Number(integerPart === '' ? '0' : integerPart);
  if (!Number.isFinite(units)) return null;

  if (currency && ZERO_DECIMAL.has(currency)) {
    // No minor unit: the whole number IS the amount.
    return fractionPart === '' ? units : null;
  }

  const minor = Number((fractionPart + '00').slice(0, 2));
  const cents = units * 100 + minor;

  // Above ~$10M on a product page is a parse error, not a price.
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 1_000_000_000 ? cents : null;
}

/** Detects a currency from a price string's symbol or ISO code. */
export function detectCurrency(raw: string): string | null {
  const isoMatch = ISO_CODE.exec(raw.toUpperCase());
  if (isoMatch && isoMatch[1] !== undefined) {
    const code = isoMatch[1];
    // Guard against matching a random three-letter word.
    if (code !== 'THE' && code !== 'AND' && code !== 'FOR') return code;
  }

  // Multi-character symbols first, so `C$` is not read as `$`.
  const symbols = Object.keys(CURRENCY_BY_SYMBOL).sort((a, b) => b.length - a.length);
  for (const symbol of symbols) {
    if (raw.includes(symbol)) return CURRENCY_BY_SYMBOL[symbol]!;
  }

  return null;
}

/**
 * Parses a price as it appears on a page, e.g. `"$19.99"`, `"€1.299,00"`.
 * Returns null rather than guessing.
 */
export function parsePrice(raw: string, currencyHint?: string | null): ParsedPrice | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const currency = detectCurrency(raw) ?? currencyHint ?? null;
  const cents = parsePriceNumber(raw, currency);
  if (cents === null) return null;

  return { cents, currency };
}

/**
 * Extracts explicitly stated offers, e.g. "20% off", "Save $5", "2 for 1".
 *
 * Deliberately conservative: it only reports what the page literally says.
 * Nothing is inferred, because a fabricated discount is both a compliance
 * problem and a lie to the customer.
 */
export interface StatedOffer {
  kind: 'percent-off' | 'amount-off' | 'bxgy' | 'free-shipping';
  /** Percent for percent-off; minor units for amount-off. */
  value?: number;
  /** The exact text the page used, kept so the claim is auditable. */
  sourceText: string;
}

const OFFER_PATTERNS: Array<{
  kind: StatedOffer['kind'];
  pattern: RegExp;
  capture?: 'percent' | 'amount';
}> = [
  {
    kind: 'percent-off',
    pattern: /(\d{1,2})\s*%\s*(?:off|discount|reduction)/i,
    capture: 'percent',
  },
  { kind: 'percent-off', pattern: /(?:save|get)\s*(\d{1,2})\s*%/i, capture: 'percent' },
  {
    kind: 'amount-off',
    pattern: /save\s*([$£€]\s?\d[\d.,]*)/i,
    capture: 'amount',
  },
  { kind: 'bxgy', pattern: /buy\s*(?:one|two|\d)\s*,?\s*get\s*(?:one|two|\d)\s*(?:free|half)/i },
  { kind: 'bxgy', pattern: /\b(?:bogo|2\s*for\s*1|3\s*for\s*2)\b/i },
  { kind: 'free-shipping', pattern: /free\s*(?:standard\s*)?(?:shipping|delivery|postage)/i },
];

export function extractStatedOffers(text: string): StatedOffer[] {
  const found: StatedOffer[] = [];
  const seen = new Set<string>();

  for (const { kind, pattern, capture } of OFFER_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const offer: StatedOffer = { kind, sourceText: match[0].trim().slice(0, 120) };

    if (capture === 'percent' && match[1] !== undefined) {
      const percent = Number(match[1]);
      // Above 95% off on a product page is almost always a parsing artefact.
      if (!Number.isFinite(percent) || percent <= 0 || percent > 95) continue;
      offer.value = percent;
    }
    if (capture === 'amount' && match[1] !== undefined) {
      const parsed = parsePrice(match[1]);
      if (parsed === null) continue;
      offer.value = parsed.cents;
    }

    const key = `${kind}:${offer.value ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(offer);
  }

  return found;
}
