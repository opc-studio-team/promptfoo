import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import yaml from 'yaml';
import { evaluate } from '../../src/node/evaluate';
import { ResultFailureReason } from '../../src/types/index';

// Invoked by the Go integration test with its actual generated HTTP target
// config. Only the Go test's loopback proxy is permitted.
const config = yaml.parse(readFileSync(0, 'utf8'));
const endpoint = new URL(config.url);
assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(config.agentExecutionContract, 'aig-agent-http/v1');

let assertions = 0;
const result = await evaluate(
  {
    providers: [{ id: 'http', config }],
    prompts: ['{{prompt}}'],
    tests: ['bad-request', 'server-error', 'success', 'sse'].map((prompt) => ({
      vars: { prompt },
      assert: [
        {
          type: 'javascript' as const,
          value: (output: string) => {
            assertions++;
            return output === 'valid answer';
          },
        },
      ],
    })),
    writeLatestResults: false,
  },
  { cache: false, maxConcurrency: 1, showProgressBar: false },
);
const summary = await result.toEvaluateSummary();
assert.equal(summary.stats.errors, 2);
assert.equal(summary.stats.successes, 2);
assert.equal(summary.stats.failures, 0);
assert.equal(assertions, 2, 'execution errors must not reach final assertions');
assert.equal(summary.results.length, 4);
for (const row of summary.results) {
  const failedCall = ['bad-request', 'server-error'].includes(String(row.vars.prompt));
  if (failedCall) {
    assert.equal(row.success, false);
    assert.equal(row.failureReason, ResultFailureReason.ERROR);
    assert.match(row.error || '', /AIG_AGENT_EXECUTION_ERROR/);
    assert.equal(row.response?.output, undefined);
    const diagnostic = row.metadata?.errorContext as Record<string, string>;
    assert.equal(diagnostic.code, 'HTTP_STATUS_ERROR');
    assert.equal(diagnostic.category, 'http');
    assert.match(diagnostic.diagnostic_id, /^[a-f0-9-]{36}$/i);
  } else {
    assert.equal(row.success, true);
    assert.equal(row.response?.output, 'valid answer');
  }
}
assert.ok(!JSON.stringify(summary).includes('UPSTREAM_PRIVATE_'));
console.log('AIG_CONTRACT_EVAL_OK errors=2 successes=2 failures=0 assertions=2');
const errorRows = summary.results.filter((row) => row.failureReason === ResultFailureReason.ERROR);
console.log(
  `AIG_CONTRACT_ERROR_SHAPE safeCode=true engineStack=${errorRows.some((row) => /\n\s+at /.test(row.error || ''))}`,
);

// Check the exact Go-generated transform against malformed/untrusted proxy
// envelopes too, using the same actual HTTP provider/evaluator.
const invalidCases = [
  'http-error-with-choices',
  'error-envelope',
  'unknown-version',
  'missing-version',
  'missing-choices',
  'empty-content',
  'whitespace-content',
  'nonstring-content',
];
const malformedProxy = createServer(async (req, res) => {
  let wire = '';
  for await (const chunk of req) {
    wire += chunk;
  }
  const scenario = JSON.parse(wire).messages[0].content;
  const envelope: Record<string, unknown> = {
    contract_version: 'aig-agent-http/v1',
    execution_status: 'success',
    choices: [{ message: { content: 'otherwise valid answer' } }],
    private: 'MALFORMED_ENVELOPE_CANARY',
  };
  switch (scenario) {
    case 'http-error-with-choices':
      res.statusCode = 400;
      break;
    case 'error-envelope':
      envelope.execution_status = 'error';
      break;
    case 'unknown-version':
      envelope.contract_version = 'unknown';
      break;
    case 'missing-version':
      delete envelope.contract_version;
      break;
    case 'missing-choices':
      delete envelope.choices;
      break;
    default:
      envelope.choices = [
        {
          message: {
            content:
              scenario === 'empty-content' ? '' : scenario === 'whitespace-content' ? ' \n\t ' : 42,
          },
        },
      ];
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Private', 'MALFORMED_ENVELOPE_CANARY');
  res.end(JSON.stringify(envelope));
});
await new Promise<void>((resolve) => malformedProxy.listen(0, '127.0.0.1', resolve));
try {
  const address = malformedProxy.address();
  assert.ok(address && typeof address === 'object');
  const invalidResult = await evaluate(
    {
      providers: [{ id: 'http', config: { ...config, url: `http://127.0.0.1:${address.port}` } }],
      prompts: ['{{prompt}}'],
      tests: invalidCases.map((prompt) => ({
        vars: { prompt },
        assert: [
          {
            type: 'javascript' as const,
            value: () => {
              assertions++;
              return true;
            },
          },
        ],
      })),
      writeLatestResults: false,
    },
    { cache: false, maxConcurrency: 1, showProgressBar: false },
  );
  const invalidSummary = await invalidResult.toEvaluateSummary();
  assert.equal(invalidSummary.stats.errors, invalidCases.length - 2);
  assert.equal(invalidSummary.stats.successes, 2);
  assert.equal(invalidSummary.stats.failures, 0);
  assert.equal(assertions, 4, 'only valid string envelopes may reach assertions');
  for (const row of invalidSummary.results) {
    if (['empty-content', 'whitespace-content'].includes(String(row.vars.prompt))) {
      assert.equal(row.response?.output, row.vars.prompt === 'empty-content' ? '' : ' \n\t ');
      continue;
    }
    assert.equal(row.failureReason, ResultFailureReason.ERROR);
    assert.equal(row.response?.output, undefined);
    assert.match(row.error || '', /AIG_AGENT_EXECUTION_ERROR/);
  }
  assert.ok(
    !JSON.stringify(
      invalidSummary.results.filter((row) => row.failureReason === ResultFailureReason.ERROR),
    ).includes('MALFORMED_ENVELOPE_CANARY'),
  );
  console.log('AIG_CONTRACT_STRICT_OK errors=6 successes=2 failures=0 assertions=2');
} finally {
  await new Promise<void>((resolve, reject) =>
    malformedProxy.close((error) => (error ? reject(error) : resolve())),
  );
}
