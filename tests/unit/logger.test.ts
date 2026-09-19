import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@/lib/logger';

function collect(level: Parameters<typeof createLogger>[0]['level'] = 'trace') {
  const records: LogRecord[] = [];
  const log = createLogger({ level, format: 'json', sink: (record) => records.push(record) });
  return { log, records };
}

describe('logger', () => {
  it('emits a structured record with timestamp, level and message', () => {
    const { log, records } = collect();
    log.info('Scan started', { businessId: 'biz_1' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      message: 'Scan started',
      businessId: 'biz_1',
    });
    expect(Date.parse(records[0]!.timestamp)).not.toBeNaN();
  });

  it('suppresses records below the configured level', () => {
    const { log, records } = collect('warn');
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(records.map((record) => record.level)).toEqual(['warn', 'error']);
  });

  it('merges child bindings into every record', () => {
    const { log, records } = collect();
    const child = log.child({ workspaceId: 'ws_1' }).child({ jobId: 'job_9' });
    child.info('Working');

    expect(records[0]).toMatchObject({ workspaceId: 'ws_1', jobId: 'job_9' });
  });

  it('does not let a child mutate its parent bindings', () => {
    const { log, records } = collect();
    log.child({ businessId: 'biz_A' }).info('child');
    log.info('parent');

    expect(records[0]).toHaveProperty('businessId', 'biz_A');
    expect(records[1]).not.toHaveProperty('businessId');
  });

  describe('redaction', () => {
    it('redacts secret-shaped keys at the top level', () => {
      const { log, records } = collect();
      log.info('Connected', { accessToken: 'EAAG-live-token', apiKey: 'sk-live-123' });

      expect(records[0]!.accessToken).toBe('[REDACTED]');
      expect(records[0]!.apiKey).toBe('[REDACTED]');
    });

    it('redacts secret-shaped keys when nested', () => {
      const { log, records } = collect();
      log.info('Integration', {
        integration: { provider: 'meta', credential: { access_token: 'EAAG-secret' } },
      });

      const integration = records[0]!.integration as Record<string, unknown>;
      expect(integration.provider).toBe('meta');
      expect(integration.credential).toBe('[REDACTED]');
    });

    it('truncates very long strings — scraped page text is unbounded', () => {
      const { log, records } = collect();
      log.info('Page fetched', { text: 'a'.repeat(5_000) });

      const text = records[0]!.text as string;
      expect(text.length).toBeLessThan(2_200);
      expect(text).toMatch(/truncated 3000 chars/);
    });

    it('serialises Error values with name, message and stack', () => {
      const { log, records } = collect();
      log.error('Failed', { error: new Error('boom') });

      const error = records[0]!.error as Record<string, unknown>;
      expect(error.name).toBe('Error');
      expect(error.message).toBe('boom');
      expect(typeof error.stack).toBe('string');
    });

    it('handles arrays and dates without throwing', () => {
      const { log, records } = collect();
      const when = new Date('2026-01-02T03:04:05.000Z');
      log.info('Batch', { items: [1, 'two', { password: 'hunter2' }], when });

      expect(records[0]!.when).toBe('2026-01-02T03:04:05.000Z');
      const items = records[0]!.items as unknown[];
      expect(items[0]).toBe(1);
      expect((items[2] as Record<string, unknown>).password).toBe('[REDACTED]');
    });

    it('stops at a bounded depth rather than recursing forever', () => {
      const { log, records } = collect();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(() => log.info('Cycle', { cyclic })).not.toThrow();
      expect(JSON.stringify(records[0])).toContain('MAX_DEPTH');
    });
  });
});
