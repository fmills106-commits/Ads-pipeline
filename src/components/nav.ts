/**
 * Primary navigation.
 *
 * Five items, not eleven. The earlier list mirrored the system's internals —
 * Websites, Products, Creatives, Experiments, Offers, Integrations — which is
 * how the engineers think about it and not how a business owner does.
 *
 * What an owner needs is: how is it going, what are the ads, what did it cost,
 * and where do I change things. Products, experiments, offers and creative
 * versions are all still there; they live inside these screens rather than
 * demanding their own tab.
 */
export interface NavItem {
  label: string;
  href: string;
  available: boolean;
  /** Phase that delivers this section, shown when unavailable. */
  phase: number;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Overview', href: '/dashboard', available: true, phase: 1 },
  { label: 'Website', href: '/website', available: true, phase: 2 },
  { label: 'Ads', href: '/ads', available: true, phase: 3 },
  { label: 'Results', href: '/results', available: false, phase: 7 },
  { label: 'Costs', href: '/costs', available: true, phase: 1 },
  { label: 'Settings', href: '/settings', available: true, phase: 1 },
] as const;
