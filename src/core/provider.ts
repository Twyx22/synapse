/** Fixed categories only: never persist raw provider messages, headers, or request bodies. */
export const providerCategories = ['provider_quota','provider_rate_limit','provider_auth','provider_invalid_request','provider_unavailable','provider_failure','session_failed','session_interrupted','provider_circuit_open'] as const;
export type ProviderCategory = typeof providerCategories[number];
export const failureSources = ["retry_hook", "terminal_event", "terminal_context", "host_error", "circuit"] as const;
export type FailureSource = typeof failureSources[number];
export class ProviderSessionError extends Error {
  readonly category: ProviderCategory;
  readonly source?: FailureSource;
  constructor(category: ProviderCategory, source?: FailureSource) { super(category); this.category=category; this.source=source; this.name = 'ProviderSessionError'; }
}
export const blocksGraph = (category: ProviderCategory) => ['provider_quota','provider_rate_limit','provider_auth'].includes(category);
export function object(value: unknown): Record<string,unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
}
/** Only invoke on trusted host error fields, never on model or tool output. */
export function classifyProviderError(value: unknown): ProviderCategory | undefined {
  const seen = new Set<unknown>();
  let current = value;
  for(let depth=0;depth<5 && current!=null && !seen.has(current);depth++) {
    seen.add(current);
    const r=object(current);
    const labels=[r?.type,r?.name,r?._tag,r?.code].filter((v):v is string=>typeof v==='string').join(' ').toLowerCase();
    const message=(typeof current==='string'?current:typeof r?.message==='string'?r.message:'').slice(0,4000).toLowerCase();
    const status=r?.status ?? r?.statusCode;
    if(/provider\.(?:quota|free-limit|budget-limit|model-budget-limit)\b|quotaexceeded|insufficient_quota/.test(labels)||/free usage limit reached|quota exceeded|insufficient (?:quota|account funds)|billing hard limit/.test(message))return 'provider_quota';
    if(/provider\.rate-limit\b|ratelimiterror|rate_limit_exceeded/.test(labels)||status===429||/rate limit exceeded|too many requests/.test(message))return 'provider_rate_limit';
    if(/provider\.(?:auth|authentication|unauthorized|forbidden)\b|authenticationerror/.test(labels)||status===401||status===403)return 'provider_auth';
    if(/provider\.invalid-request\b|invalidrequesterror/.test(labels)||status===400||status===422)return 'provider_invalid_request';
    if(/provider\.(?:internal|unavailable|overloaded|timeout)\b/.test(labels)||typeof status==='number'&&status>=500&&status<=599)return 'provider_unavailable';
    if(/(?:^|\s)provider\./.test(labels))return 'provider_failure';
    current=r?.cause ?? r?.error;
  }
  return undefined;
}
/** A fresh Synapse session has one prompt. Inspect its latest terminal marker, not text. */
export function terminalFailure(messages: readonly unknown[]): ProviderCategory | undefined {
  for(let i=messages.length-1;i>=0;i--) {
    const row=object(messages[i]);
    if(row?.type==='user'||row?.role==='user')break;
    if(row?.type!=='idle')continue;
    if(row.outcome==='failed')return classifyProviderError(row.error)??'session_failed';
    if(row.outcome==='interrupted')return 'session_interrupted';
    return undefined;
  }
  return undefined;
}
