import { afterEach, describe, expect, it, vi } from 'vitest';
import logger from '../../src/logger';
import { HttpProviderConfigSchema } from '../../src/providers/http';
import { createTransformResponse } from '../../src/providers/httpTransforms';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('custom HTTP execution contract safe transform errors', () => {
  it.each(['string', 'function'])('does not attach raw data for %s transforms', async (kind) => {
    const log = vi.spyOn(logger, 'error');
    const secret = 'PRIVATE_TRANSFORM_CANARY';
    const parser =
      kind === 'string'
        ? '(json) => { throw new Error(json.secret); }'
        : (json: { secret: string }) => {
            throw new Error(json.secret);
          };
    const transform = await createTransformResponse(parser, true);
    let caught: unknown;
    try {
      transform({ secret }, secret, {
        response: { status: 500, data: secret, headers: { private: secret } },
      } as any);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('AIG_AGENT_EXECUTION_ERROR');
    expect(String(caught)).not.toContain(secret);
    expect((caught as Error).cause).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps successful transform and legacy opt-out behavior', async () => {
    const safe = await createTransformResponse('json.answer', true);
    expect(safe({ answer: 'valid' }, '').output).toBe('valid');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const legacy = await createTransformResponse('json.missing[0]');
    expect(() => legacy({}, 'legacy-body')).toThrow(/legacy-body/);
    expect(log).toHaveBeenCalled();
  });

  it('preserves only the explicit supported contract marker', () => {
    expect(
      HttpProviderConfigSchema.parse({
        body: {},
        agentExecutionContract: 'aig-agent-http/v1',
      }).agentExecutionContract,
    ).toBe('aig-agent-http/v1');
    expect(HttpProviderConfigSchema.parse({ body: {} }).agentExecutionContract).toBeUndefined();
    expect(() =>
      HttpProviderConfigSchema.parse({ body: {}, agentExecutionContract: 'unknown' }),
    ).toThrow();
  });
});
