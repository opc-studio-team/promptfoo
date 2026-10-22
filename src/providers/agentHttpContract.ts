import type { ApiProvider, AssertionOrSet, ProviderResponse } from '../types/index';

export const AGENT_HTTP_CONTRACT = 'aig-agent-http/v1';
const trustedResponse = Symbol('agent-http-response');

export function isAgentHTTPProvider(provider?: ApiProvider): boolean {
  return provider?.config?.agentExecutionContract === AGENT_HTTP_CONTRACT;
}

export function markAgentHTTPResponse(response: ProviderResponse): ProviderResponse {
  Object.defineProperty(response, trustedResponse, { value: true, enumerable: true });
  return response;
}

export function isAgentHTTPResponse(response?: ProviderResponse): boolean {
  return Boolean(response && (response as any)[trustedResponse]);
}

export function hasEffectiveAgentAssertion(assertions?: AssertionOrSet[]): boolean {
  return Boolean(
    assertions?.some(
      (assertion) =>
        assertion.weight !== 0 &&
        (assertion.type === 'assert-set'
          ? hasEffectiveAgentAssertion(assertion.assert)
          : typeof assertion.type === 'string' &&
            assertion.type.length > 0 &&
            (!['javascript', 'not-javascript'].includes(assertion.type) ||
              typeof assertion.value === 'function' ||
              (typeof assertion.value === 'string' && assertion.value.trim().length > 0))),
    ),
  );
}

const codes = new Set([
  'CONFIG_ERROR',
  'REQUEST_READ_ERROR',
  'TRANSPORT_ERROR',
  'HTTP_STATUS_ERROR',
  'RESPONSE_READ_ERROR',
  'RESPONSE_PARSE_ERROR',
  'OUTPUT_MISSING',
  'OUTPUT_NULL',
  'OUTPUT_TYPE',
  'SSE_EXECUTION_ERROR',
]);
const categories = new Set(['config', 'request', 'transport', 'http', 'read', 'parse', 'business']);

// Called only at the platform-generated HTTP boundary. Rebuild from a closed
// allowlist; never copy arbitrary Error properties, response text or context.
export function safeAgentHTTPError(data?: any): Error & { diagnostic?: Record<string, string> } {
  const detail =
    data?.contract_version === AGENT_HTTP_CONTRACT && data?.execution_status === 'error'
      ? data.error
      : undefined;
  const diagnostic: Record<string, string> = {};
  if (codes.has(detail?.code)) {
    diagnostic.code = detail.code;
  }
  if (categories.has(detail?.category)) {
    diagnostic.category = detail.category;
  }
  if (
    typeof detail?.diagnostic_id === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(detail.diagnostic_id)
  ) {
    diagnostic.diagnostic_id = detail.diagnostic_id;
  }
  return Object.assign(new Error('AIG_AGENT_EXECUTION_ERROR'), { diagnostic });
}
