import { Card } from '@/components/ui/primitives';

/**
 * What to do when a firewall in front of the owner's site refuses the crawler.
 *
 * Shown only for 401 / 403 / 429, because this is the one scan failure an
 * owner can nearly always clear themselves — and the one where knowing the
 * cause is most of the fix. The first real site to hit it was behind
 * Cloudflare, whose bot protection is on by default and refuses anything it
 * does not recognise.
 *
 * Written as steps rather than an explanation, and provider by provider,
 * because "allow our user agent in your firewall" is a sentence that assumes
 * the reader already knows where that is.
 *
 * The Cloudflare note about the free plan is deliberate and was learned the
 * hard way: the obvious advice — add a WAF rule allowing the crawler — does
 * nothing there. Cloudflare's own documentation says Bot Fight Mode "does not
 * run on the Ruleset Engine", so Skip, Bypass and Allow have no effect on it.
 * An owner who followed that advice would change a setting, see no
 * improvement, and reasonably conclude the application is broken.
 */
export function BlockedHelp({ status, userAgent }: { status: number; userAgent: string }) {
  return (
    <Card className="mb-5">
      <h2 className="mb-1 text-sm font-semibold">How to let us read your site</h2>
      <p className="mb-4 text-sm text-ink-muted">
        {status === 429
          ? 'Something in front of your website is rate-limiting us.'
          : 'Something in front of your website is refusing us.'}{' '}
        It is not a problem with your site, and nothing is wrong with your account. You need to tell
        that service we are allowed. We identify ourselves as:
      </p>

      <p className="mb-5 rounded-md bg-surface-muted px-3 py-2 font-mono text-sm">{userAgent}</p>

      <div className="space-y-5 text-sm">
        <section>
          <h3 className="mb-1 font-medium">If your site is on Cloudflare</h3>
          <p className="text-ink-muted">
            This is the usual cause. In Cloudflare, choose your domain, then{' '}
            <strong>Security → Settings</strong>, and turn <strong>Bot Fight Mode</strong> off.
          </p>
          <p className="mt-2 text-ink-muted">
            On the free plan that is the only way: Bot Fight Mode has no allow-list, and a WAF rule
            permitting us has no effect on it. On a paid plan, <strong>Super Bot Fight Mode</strong>{' '}
            lets you allow us specifically and leave the rest switched on.
          </p>
        </section>

        <section>
          <h3 className="mb-1 font-medium">If your site is on WordPress</h3>
          <p className="text-ink-muted">
            A security plugin — Wordfence, Sucuri, All In One WP Security — is most likely blocking
            us. Find its blocking or firewall log, look for the name above, and allow it.
          </p>
        </section>

        <section>
          <h3 className="mb-1 font-medium">Shopify, Squarespace, Wix and similar</h3>
          <p className="text-ink-muted">
            These rarely block anything, so a refusal usually means a password page or a
            store-not-yet-published setting. Check that your site is publicly visible without
            signing in.
          </p>
        </section>

        <section>
          <h3 className="mb-1 font-medium">Anything else</h3>
          <p className="text-ink-muted">
            Open your site in a private browser window. If it loads for you but not for us, the
            block is in whatever sits in front of it — a CDN, a firewall, or your host&rsquo;s bot
            protection. Allow the name above there.
          </p>
        </section>
      </div>

      <p className="mt-5 border-t border-border-subtle pt-4 text-sm text-ink-muted">
        Once you have changed it, press <strong>Read my website</strong> again. A change can take a
        minute to take effect.
      </p>
    </Card>
  );
}
