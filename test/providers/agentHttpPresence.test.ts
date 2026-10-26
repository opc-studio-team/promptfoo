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
  it('classifies a transform throw on a success envelope through the closed code map', () => {
    // The platform transform throws AIG_AGENT_OUTPUT_* on data that carries no
    // error envelope; without cause classification this recorded an empty
    // errorContext and the frontend showed a bare "[Error] 2".
    const error = safeAgentHTTPError(
      { contract_version: 'aig-agent-http/v1', execution_status: 'success' },
      new Error('AIG_AGENT_OUTPUT_TYPE'),
    );
    expect(error.diagnostic).toEqual({ code: 'OUTPUT_TYPE', category: 'parse' });
  });
  it.each([
    ['AIG_AGENT_HTTP_STATUS', 'HTTP_STATUS_ERROR', 'http'],
    ['AIG_AGENT_INVALID_ENVELOPE', 'RESPONSE_PARSE_ERROR', 'parse'],
    ['AIG_AGENT_OUTPUT_MISSING', 'OUTPUT_MISSING', 'parse'],
    ['AIG_AGENT_OUTPUT_NULL', 'OUTPUT_NULL', 'parse'],
    ['AIG_AGENT_OUTPUT_TYPE', 'OUTPUT_TYPE', 'parse'],
  ])('maps transform throw code %s', (message, code, category) => {
    expect(safeAgentHTTPError({}, new Error(message)).diagnostic).toEqual({ code, category });
  });
  it('never classifies or echoes an arbitrary cause message', () => {
    const error = safeAgentHTTPError(
      { contract_version: 'aig-agent-http/v1', execution_status: 'success' },
      new Error('PRIVATE_UPSTREAM_FAILURE'),
    );
    expect(error.diagnostic).toEqual({});
    expect(error.message).toBe('AIG_AGENT_EXECUTION_ERROR');
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });
  it('prefers envelope detail over the thrown cause classification', () => {
    const error = safeAgentHTTPError(
      {
        contract_version: 'aig-agent-http/v1',
        execution_status: 'error',
        error: { code: 'HTTP_STATUS_ERROR', category: 'http' },
      },
      new Error('AIG_AGENT_OUTPUT_TYPE'),
    );
    expect(error.diagnostic).toEqual({ code: 'HTTP_STATUS_ERROR', category: 'http' });
  });
});
