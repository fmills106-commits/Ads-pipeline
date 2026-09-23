/**
 * robots.txt parsing.
 *
 * Respecting robots.txt is not optional for a crawler that identifies itself
 * and runs on someone else's behalf. The rules implemented here follow the
 * de-facto standard (RFC 9309):
 *
 *  - group directives by `User-agent`, and use the most specific matching
 *    group rather than merging all of them;
 *  - longest matching path wins between Allow and Disallow, with Allow winning
 *    a tie — the behaviour Google and Bing both implement;
 *  - `Disallow:` with an empty value allows everything;
 *  - `*` and `$` are the only wildcards.
 *
 * A missing or unparseable robots.txt means "crawl politely", not "do not
 * crawl": a merchant who asked us to scan their own site should not be blocked
 * by their host serving an HTML error page for /robots.txt.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one group of rules.
  let expectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!expectingAgents || current === null) {
          current = { agents: [], rules: [] };
          groups.push(current);
          expectingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        if (current === null) break; // Directive before any User-agent: ignore.
        expectingAgents = false;
        // `Disallow:` with no value is an explicit "allow everything".
        if (field === 'disallow' && value === '') break;
        if (value === '') break;
        current.rules.push({ type: field, path: value });
        break;
      }
      case 'crawl-delay': {
        if (current === null) break;
        expectingAgents = false;
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
        break;
      }
      case 'sitemap': {
        // Sitemap is global, not per-group.
        if (value !== '') sitemaps.push(value);
        break;
      }
      default:
        break;
    }
  }

  return { groups, sitemaps };
}

/**
 * Picks the group that applies to `userAgent`.
 *
 * The most specific match wins: an exact substring match on our token beats
 * `*`. When several named groups match, the longest token wins.
 */
export function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const agent = userAgent.toLowerCase();

  let best: { group: RobotsGroup; score: number } | null = null;

  for (const group of robots.groups) {
    for (const candidate of group.agents) {
      let score = -1;
      if (candidate === '*') score = 0;
      else if (agent.includes(candidate)) score = candidate.length;

      if (score >= 0 && (best === null || score > best.score)) {
        best = { group, score };
      }
    }
  }

  return best?.group ?? null;
}

/** Converts a robots path pattern (with `*` and `$`) into a regular expression. */
function patternToRegExp(pattern: string): RegExp {
  let source = '';
  for (const character of pattern) {
    if (character === '*') source += '.*';
    else if (character === '$') source += '$';
    else source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}`);
}

/** Length of the literal prefix of a pattern, used for specificity. */
function matchLength(pattern: string): number {
  return pattern.replace(/\$$/, '').length;
}

/**
 * Whether `pathname` may be fetched.
 *
 * Longest match wins; Allow beats Disallow on an equal-length match, which is
 * what lets a site disallow `/admin` but allow `/admin/public`.
 */
export function isAllowed(robots: RobotsTxt, userAgent: string, pathname: string): boolean {
  const group = selectGroup(robots, userAgent);
  if (group === null || group.rules.length === 0) return true;

  const path = pathname === '' ? '/' : pathname;

  let decision: { allow: boolean; length: number } | null = null;

  for (const rule of group.rules) {
    if (!patternToRegExp(rule.path).test(path)) continue;
    const length = matchLength(rule.path);
    const allow = rule.type === 'allow';

    if (
      decision === null ||
      length > decision.length ||
      (length === decision.length && allow && !decision.allow)
    ) {
      decision = { allow, length };
    }
  }

  return decision?.allow ?? true;
}

/** The crawl delay this site asked for, if any. */
export function crawlDelayMs(robots: RobotsTxt, userAgent: string): number | null {
  const group = selectGroup(robots, userAgent);
  const seconds = group?.crawlDelaySeconds;
  return seconds === undefined ? null : Math.round(seconds * 1000);
}

/**
 * Decides whether a body is actually robots.txt.
 *
 * Plenty of hosts answer /robots.txt with a styled 404 page. Treating that
 * HTML as a rule set would produce nonsense, so anything that looks like
 * markup is rejected and the crawl proceeds under its own limits.
 */
export function looksLikeRobotsTxt(body: string, contentType: string | null): boolean {
  if (contentType !== null && /html/i.test(contentType)) return false;
  const head = body.slice(0, 500).toLowerCase();
  if (head.includes('<!doctype html') || head.includes('<html')) return false;
  return true;
}
