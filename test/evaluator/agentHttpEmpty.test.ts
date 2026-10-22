import { describe, expect, it, vi } from 'vitest';
import { runEval } from '../../src/evaluator';
import { evaluate } from '../../src/node/evaluate';
import { ResultFailureReason } from '../../src/types/index';

const contract = { agentExecutionContract: 'aig-agent-http/v1' };

async function evaluateOutput(
  output: unknown,
  assertions?: any[],
  responseExtra = {},
  config: any = contract,
  testExtra = {},
) {
  const provider = {
    id: () => 'synthetic-http',
    config,
    callApi: vi.fn().mockResolvedValue({ output, ...responseExtra }),
  };
  const rows = await runEval({
    provider,
    prompt: { raw: 'synthetic', label: 'synthetic' },
    test: { assert: assertions, ...testExtra },
    delay: 0,
    testIdx: 0,
    promptIdx: 0,
    repeatIndex: 0,
    isRedteam: true,
    conversations: {},
    registers: {},
  });
  return rows[0];
}

describe('custom HTTP actual assertion grading', () => {
  it.each([
    '',
    ' \n\t ',
  ])('empty input %j can PASS and FAIL explicit boolean assertions', async (output) => {
    const equals = vi.fn((actual: string) => typeof actual === 'string' && actual === output);
    const nonempty = vi.fn(
      (actual: string) => typeof actual === 'string' && actual.trim().length > 0,
    );
    const pass = await evaluateOutput(output, [{ type: 'javascript', value: equals }]);
    const fail = await evaluateOutput(output, [{ type: 'javascript', value: nonempty }]);
    expect(pass.success).toBe(true);
    expect(fail.success).toBe(false);
    expect(fail.failureReason).toBe(ResultFailureReason.ASSERT);
    expect(pass.response?.output).toBe(output);
    expect(fail.response?.output).toBe(output);
    expect(equals).toHaveBeenCalledExactlyOnceWith(output, expect.anything());
    expect(nonempty).toHaveBeenCalledExactlyOnceWith(output, expect.anything());
  });
  it.each([
    undefined,
    null,
    42,
    false,
    {},
    [],
  ])('does not score invalid output %j', async (output) => {
    const assertion = vi.fn(() => true);
    const row = await evaluateOutput(output, [{ type: 'javascript', value: assertion }]);
    expect(row.success).toBe(false);
    expect(row.failureReason).toBe(ResultFailureReason.ERROR);
    expect(assertion).not.toHaveBeenCalled();
  });
  it('does not score error plus empty output', async () => {
    const assertion = vi.fn(() => true);
    const row = await evaluateOutput('', [{ type: 'javascript', value: assertion }], {
      error: 'safe error',
    });
    expect(row.failureReason).toBe(ResultFailureReason.ERROR);
    expect(assertion).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    [],
    [{ type: 'assert-set', assert: [] }],
    [{ type: 'javascript', weight: 0, value: 'true' }],
  ])('no effective assertion %j is configuration ERROR', async (assertions) => {
    const row = await evaluateOutput('', assertions);
    expect(row.error).toBe('EVAL_ASSERTION_REQUIRED');
    expect(row.success).toBe(false);
    expect(row.failureReason).toBe(ResultFailureReason.ERROR);
  });
  it('uses merged defaultTest assertions through evaluate', async () => {
    let count = 0;
    const result = await evaluate(
      {
        providers: [
          { id: () => 'synthetic-http', config: contract, callApi: async () => ({ output: '' }) },
        ],
        prompts: ['synthetic'],
        defaultTest: {
          assert: [
            {
              type: 'javascript',
              value: (output: string) => {
                count++;
                return output === '';
              },
            },
          ],
        },
        tests: [{ vars: {} }],
        writeLatestResults: false,
      },
      { cache: false, showProgressBar: false },
    );
    expect((await result.toEvaluateSummary()).stats.successes).toBe(1);
    expect(count).toBe(1);
  });
  it('keeps no-assertion behavior unchanged outside the contract', async () => {
    expect((await evaluateOutput('', undefined, {}, {})).success).toBe(true);
  });
  it.each([
    '',
    null,
    undefined,
    { invalid: true },
  ])('still rejects invalid JS assertion return %j', async (value) => {
    const row = await evaluateOutput('', [{ type: 'javascript', value: () => value }]);
    expect(row.success).toBe(false);
  });
  it.each([false, 0])('keeps falsy valid JS verdict %j as FAIL', async (value) => {
    expect((await evaluateOutput('', [{ type: 'javascript', value: () => value }])).success).toBe(
      false,
    );
  });
  it.each([
    '',
    ' \n\t ',
    () => {},
    () => undefined,
    () => null,
    () => '',
    () => ({}),
  ])('invalid JS %j is ERROR even with threshold zero and another passing assertion', async (value) => {
    for (const threshold of [undefined, 0]) {
      for (const mixed of [false, true]) {
        const assertions = [{ type: 'javascript', value }];
        if (mixed) {
          assertions.push({ type: 'javascript', value: () => true });
        }
        const row = await evaluateOutput('', assertions, {}, contract, { threshold });
        expect(row.success).toBe(false);
        expect(row.failureReason).toBe(ResultFailureReason.ERROR);
        expect(row.score).toBe(0);
      }
    }
  });
  it('does not aggregate an invalid nested JS verdict into PASS', async () => {
    const row = await evaluateOutput(
      '',
      [
        {
          type: 'assert-set',
          threshold: 0,
          assert: [
            { type: 'javascript', value: () => {} },
            { type: 'javascript', value: () => true },
          ],
        },
      ],
      {},
      contract,
      { threshold: 0 },
    );
    expect(row.success).toBe(false);
    expect(row.failureReason).toBe(ResultFailureReason.ERROR);
  });
  it.each([
    ['equals', '', true],
    ['equals', 'not empty', false],
    ['contains', 'not empty', false],
    ['javascript', (output: string) => output === '', true],
    ['javascript', () => true, true],
    ['javascript', () => false, false],
    ['javascript', () => 1, true],
    ['javascript', () => 0, false],
    ['javascript', () => ({ pass: true, score: 1, reason: 'valid' }), true],
    ['javascript', () => ({ pass: false, score: 0, reason: 'valid' }), false],
  ])('preserves valid empty output assertion %s (%j)', async (type, value, success) => {
    const row = await evaluateOutput('', [{ type, value }]);
    expect(row.success).toBe(success);
    expect(row.failureReason).toBe(success ? ResultFailureReason.NONE : ResultFailureReason.ASSERT);
  });
  it('preserves the repo contains-empty configuration ERROR contract', async () => {
    const row = await evaluateOutput('', [{ type: 'contains', value: '' }]);
    expect(row.success).toBe(false);
    expect(row.failureReason).toBe(ResultFailureReason.ERROR);
  });
});
