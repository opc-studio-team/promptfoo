import { afterEach, describe, expect, it, vi } from 'vitest';
import cliState from '../../../src/cliState';
import { matchesLlmRubric } from '../../../src/matchers/llmGrading';
import { RedteamGraderBase } from '../../../src/redteam/plugins/base';
import { runRedteamConversation } from '../../../src/redteam/providers/iterative';
import { getTargetResponse, redteamProviderManager } from '../../../src/redteam/providers/shared';

vi.mock('../../../src/matchers/llmGrading', async (importOriginal) => ({
  ...(await importOriginal()),
  matchesLlmRubric: vi.fn(),
}));
const getGrader = vi.hoisted(() => vi.fn());
vi.mock('../../../src/redteam/graders', async (importOriginal) => ({
  ...(await importOriginal()),
  getGraderById: getGrader,
}));
vi.mock('../../../src/redteam/remoteGeneration', async (importOriginal) => ({
  ...(await importOriginal()),
  shouldGenerateRemote: () => false,
}));

class LocalGrader extends RedteamGraderBase {
  id = 'synthetic';
  rubric = 'A local counted decision, not an empty-response shortcut.';
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  cliState.config = {};
});

describe('custom HTTP strategy boundaries', () => {
  it.each(['', ' \n\t '])('shared preserves valid answer %j', async (output) => {
    expect(
      (
        await getTargetResponse(
          {
            id: () => 'synthetic',
            config: { agentExecutionContract: 'aig-agent-http/v1' },
            callApi: async () => ({ output }),
          },
          'synthetic',
        )
      ).output,
    ).toBe(output);
  });

  it.each([
    { output: '', error: 'PRIVATE_ERROR' },
    {},
    { output: null },
    { output: 42 },
  ])('shared rejects invalid/error result before grading: %j', async (response) => {
    await expect(
      getTargetResponse(
        {
          id: () => 'synthetic',
          config: { agentExecutionContract: 'aig-agent-http/v1' },
          callApi: async () => response as any,
        },
        'synthetic',
      ),
    ).rejects.toThrow('AIG_AGENT_EXECUTION_ERROR');
  });

  it.each([
    true,
    false,
  ])('iterative retains an empty same-turn witness with rubric pass=%j', async (pass) => {
    let attacks = 0;
    let judges = 0;
    const attacker = {
      id: () => 'local-attacker',
      callApi: vi.fn(async () => ({
        output: JSON.stringify({ improvement: 'synthetic', prompt: `turn-${++attacks}` }),
      })),
    };
    const judge = {
      id: () => 'local-judge',
      callApi: vi.fn(async () => ({
        output: JSON.stringify({
          currentResponse: { rating: ++judges === 1 ? 7 : 1, explanation: 'local' },
          previousBestResponse: { rating: 7, explanation: 'local' },
        }),
      })),
    };
    const target = {
      id: () => 'synthetic-http',
      config: { agentExecutionContract: 'aig-agent-http/v1' },
      callApi: vi
        .fn()
        .mockResolvedValueOnce({ output: '' })
        .mockResolvedValueOnce({ output: 'later' }),
    };
    vi.mocked(matchesLlmRubric)
      .mockReset()
      .mockResolvedValueOnce({ pass, score: pass ? 1 : 0, reason: 'first-turn' })
      .mockResolvedValueOnce({ pass: true, score: 1, reason: 'second-turn' });
    getGrader.mockReturnValue(new LocalGrader());
    vi.spyOn(redteamProviderManager, 'getGradingProvider').mockResolvedValue(judge);
    cliState.config = { redteam: { provider: 'local-judge' } } as any;
    const result = await runRedteamConversation({
      context: { prompt: { raw: '{{prompt}}', label: 'synthetic' }, vars: { prompt: 'goal' } },
      filters: undefined,
      injectVar: 'prompt',
      numIterations: 2,
      options: {},
      prompt: { raw: '{{prompt}}', label: 'synthetic' },
      redteamProvider: attacker,
      gradingProvider: judge,
      targetProvider: target,
      vars: { prompt: 'goal' },
      excludeTargetOutputFromAgenticAttackGeneration: false,
      test: {
        metadata: { purpose: 'synthetic', pluginId: 'synthetic' },
        assert: [{ type: 'promptfoo:redteam:synthetic' as any }],
      },
    });
    expect(result.output).toBe('');
    expect(result.prompt).toBe('turn-1');
    expect(result.metadata.storedGraderResult?.pass).toBe(pass);
    expect(result.metadata.storedGraderResult?.reason).toBe('first-turn');
    expect(matchesLlmRubric).toHaveBeenCalledTimes(pass ? 2 : 1);
    expect(vi.mocked(matchesLlmRubric).mock.calls[0][1]).toBe('');
    if (!pass) {
      expect(judge.callApi).not.toHaveBeenCalled();
      expect(result.metadata.redteamHistory[0].output).toBe('');
      expect(result.metadata.redteamHistory[0].graderPassed).toBe(false);
    }
  });

  it('an execution error reaches neither internal rubric nor judge', async () => {
    vi.mocked(matchesLlmRubric).mockReset();
    const judge = { id: () => 'local-judge', callApi: vi.fn() };
    const attacker = {
      id: () => 'local-attacker',
      callApi: async () => ({
        output: JSON.stringify({ improvement: 'local', prompt: 'turn-1' }),
      }),
    };
    await expect(
      runRedteamConversation({
        context: { prompt: { raw: '{{prompt}}', label: 'synthetic' }, vars: { prompt: 'goal' } },
        filters: undefined,
        injectVar: 'prompt',
        numIterations: 1,
        options: {},
        prompt: { raw: '{{prompt}}', label: 'synthetic' },
        redteamProvider: attacker,
        gradingProvider: judge,
        targetProvider: {
          id: () => 'synthetic',
          config: { agentExecutionContract: 'aig-agent-http/v1' },
          callApi: async () => ({ output: '', error: 'PRIVATE_ERROR' }),
        },
        vars: { prompt: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
        test: {
          metadata: { purpose: 'synthetic', pluginId: 'synthetic' },
          assert: [{ type: 'promptfoo:redteam:synthetic' as any }],
        },
      }),
    ).rejects.toThrow('AIG_AGENT_EXECUTION_ERROR');
    expect(matchesLlmRubric).not.toHaveBeenCalled();
    expect(judge.callApi).not.toHaveBeenCalled();
  });
});
