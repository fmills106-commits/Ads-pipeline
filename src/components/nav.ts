/**
 * The application's primary navigation (§26).
 *
 * Declared as data so the shell renders from one list. Sections whose phase
 * has not shipped are marked `available: false` — they appear, disabled, with
 * the phase that will bring them. Showing the shape of the finished product
 * while being honest about what works is better than either hiding it or
 * linking to a stub that 404s.
 */
export interface NavItem {
  label: string;
  href: string;
  available: boolean;
  /** Phase that delivers this section; shown as a tooltip when unavailable. */
  phase: number;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', available: true, phase: 1 },
  { label: 'Businesses', href: '/businesses', available: true, phase: 1 },
  { label: 'Websites', href: '/websites', available: false, phase: 2 },
  { label: 'Products', href: '/products', available: false, phase: 2 },
  { label: 'Campaigns', href: '/campaigns', available: false, phase: 5 },
  { label: 'Creatives', href: '/creatives', available: false, phase: 4 },
  { label: 'Experiments', href: '/experiments', available: false, phase: 8 },
  { label: 'Analytics', href: '/analytics', available: false, phase: 7 },
  { label: 'Offers', href: '/offers', available: false, phase: 3 },
  { label: 'Integrations', href: '/integrations', available: false, phase: 6 },
  { label: 'Settings', href: '/settings', available: true, phase: 1 },
] as const;
