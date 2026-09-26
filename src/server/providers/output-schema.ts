import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * The shape a model is asked for, derived from the shape validation demands.
 *
 * Callers of the AI capability supply a Zod schema and get back a parsed value;
 * that schema is the only definition of what is acceptable. A provider talking
 * to a real model also needs that definition *up front*, to constrain what the
 * model generates — and writing it out a second time, by hand, in JSON Schema,
 * would be two definitions that agree until someone edits one of them.
 *
 * So it is derived. The conversion lives in the provider layer rather than in
 * the marketing engine because it exists for providers: the free one has no use
 * for it and ignores it.
 */

const cache = new WeakMap<ZodTypeAny, Record<string, unknown>>();

/**
 * The caller's schema as JSON Schema.
 *
 * Cached per schema object. The schemas are module-level constants, so this runs
 * once per process per schema rather than on every call — including on the free
 * path, which discards the result.
 */
export function jsonSchemaOf(schema: ZodTypeAny): Record<string, unknown> {
  const cached = cache.get(schema);
  if (cached) return cached;

  const converted = zodToJsonSchema(schema, {
    // Inlined rather than referenced: a provider transforming this for a model
    // has less to go wrong with, and these schemas are small.
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  // Meaningless to a model, and providers that transform this schema push
  // unrecognised keywords into the description, where it would be noise.
  delete converted['$schema'];

  cache.set(schema, converted);
  return converted;
}
