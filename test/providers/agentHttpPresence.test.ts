import { describe, expect, it } from 'vitest';
import {
  hasEffectiveAgentAssertion,
  isAgentHTTPProvider,
  isAgentHTTPResponse,
  markAgentHTTPResponse,
  safeAgentHTTPError,
} from '../../src/providers/agentHttpContract';

describe('custom HTTP local contract', () => {
  it('does not trust target metadata as a contract marker', () => {
    expect(
      isAgentHTTPResponse({
        output: '',
        metadata: { agentExecutionContract: 'aig-agent-http/v1' },
      }),
    ).toBe(false);
    expect(isAgentHTTPResponse(markAgentHTTPResponse({ output: '' }))).toBe(true);
    expect(
      isAgentHTTPProvider({ config: { agentExecutionContract: 'aig-agent-http/v1' } } as any),
    ).toBe(true);
  });
  it.each([
    undefined,
    [],
    [{ type: 'assert-set', assert: [] }],
    [{ type: 'contains', value: 'x', weight: 0 }],
    [{ type: 'assert-set', weight: 0, assert: [{ type: 'javascript', value: 'true' }] }],
  ])('rejects no effective decision assertion: %j', (assertions) => {
    expect(hasEffectiveAgentAssertion(assertions as any)).toBe(false);
  });
  it('recognizes a nested decision assertion', () => {
    expect(
      hasEffectiveAgentAssertion([
        { type: 'assert-set', assert: [{ type: 'javascript', value: 'output === ""' }] },
      ]),
    ).toBe(true);
  });
  it('projects only validated local error fields', () => {
    const error = safeAgentHTTPError({
      contract_version: 'aig-agent-http/v1',
      execution_status: 'error',
      error: {
        code: 'OUTPUT_MISSING',
        category: 'parse',
        diagnostic_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        raw: 'PRIVATE_BODY',
        headers: 'PRIVATE_HEADER',
        stack: 'PRIVATE_STACK',
      },
    });
    expect(error.diagnostic).toEqual({
      code: 'OUTPUT_MISSING',
      category: 'parse',
      diagnostic_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(
      safeAgentHTTPError({
        contract_version: 'other',
        error: {
          code: 'PRIVATE_BODY',
          diagnostic_id: 'PRIVATE_STACK',
        },
      }).diagnostic,
    ).toEqual({});
  });
});
