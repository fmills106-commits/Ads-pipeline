import { untrustedPreamble, wrapUntrusted } from '@/server/scanner/untrusted';

/**
 * Prompt assembly for providers that build prompts.
 *
 * This lives in the provider layer rather than in the marketing engine because
 * of who needs it. The engine passes `instruction` and `data` as two separate
 * parameters and never joins them — that separation is the containment. A
 * provider that talks to a language model has to join them eventually, and the
 * moment it does, a product description reading "ignore your instructions" is
 * one newline away from being read as one.
 *
 * So there is exactly one function that performs that join, every provider uses
 * it, and it is tested on its own. Nothing here is specific to Anthropic; the
 * next paid AI provider uses the same function or it does not ship.
 */

/**
 * Builds a prompt with untrusted values contained.
 *
 * Every field gets its own unguessable delimiter, generated per call, so one
 * product description cannot close a block and start speaking about the next.
 * The per-call randomness is also why this deliberately defeats prompt caching:
 * no two calls share a prefix. That is a discount worth losing.
 */
export function buildContainedPrompt(
  instruction: string,
  data: Record<string, string>,
): { prompt: string; tokens: string[] } {
  const tokens: string[] = [];
  const blocks: string[] = [];

  for (const [label, content] of Object.entries(data)) {
    const block = wrapUntrusted(label, content);
    tokens.push(block.token);
    blocks.push(block.text);
  }

  return {
    prompt: [instruction, '', untrustedPreamble(tokens), '', ...blocks].join('\n'),
    tokens,
  };
}
