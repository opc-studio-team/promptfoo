import { afterEach, describe, expect, it, vi } from 'vitest';
import cliState from '../../../src/cliState';
import { matchesLlmRubric } from '../../../src/matchers/llmGrading';
import { markAgentHTTPResponse } from '../../../src/providers/agentHttpContract';
import { RedteamGraderBase } from '../../../src/redteam/plugins/base';
import { SsrfGrader } from '../../../src/redteam/plugins/ssrf';
import { redteamProviderManager } from '../../../src/redteam/providers/shared';

vi.mock('../../../src/matchers/llmGrading', async (importOriginal) => ({
  ...(await importOriginal()),
  matchesLlmRubric: vi.fn(),
}));
class LocalGrader extends RedteamGraderBase {
  id = 'synthetic';
  rubric = 'Apply the configured decision even to an empty response.';
}
afterEach(() => {
  vi.restoreAllMocks();
  cliState.config = {};
});
describe('contract empty answer reaches original rubric', () => {
  for (const Grader of [LocalGrader, SsrfGrader]) {
    it.each([
      { output: '', pass: true },
      { output: '', pass: false },
      { output: ' \n\t ', pass: true },
      { output: ' \n\t ', pass: false },
    ])(`${Grader.name}: %j`, async ({ output, pass }) => {
      const rubric = vi
        .mocked(matchesLlmRubric)
        .mockReset()
        .mockResolvedValue({
          pass,
          score: pass ? 1 : 0,
          reason: pass ? 'severity: none' : 'severity: high',
        });
      const gradingProvider = { id: () => 'synthetic-grader', callApi: vi.fn() };
      vi.spyOn(redteamProviderManager, 'getGradingProvider').mockResolvedValue(gradingProvider);
      cliState.config = { redteam: { provider: 'synthetic-grader' } } as any;
      const result = await new Grader().getResult(
        'synthetic',
        output,
        { vars: {}, metadata: { purpose: 'loopback synthetic' } },
        gradingProvider,
        undefined,
        undefined,
        undefined,
        { providerResponse: markAgentHTTPResponse({ output }) },
      );
      expect(rubric).toHaveBeenCalledTimes(1);
      expect(rubric.mock.calls[0][1]).toBe(output);
      expect(result.grade.pass).toBe(pass);
    });
  }
  it('legacy provider still uses the empty refusal shortcut', async () => {
    vi.mocked(matchesLlmRubric).mockReset();
    const result = await new LocalGrader().getResult(
      'synthetic',
      '',
      { metadata: { purpose: 'synthetic' } },
      undefined,
      undefined,
    );
    expect(result.grade.pass).toBe(true);
    expect(matchesLlmRubric).not.toHaveBeenCalled();
  });
});
