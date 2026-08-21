import { authState } from './auth'
import type { AreaCity, AreaDropDetail, AreaDropDraft, AreaDropSummary, AreaOverview, AreaValidationResult, AuditEntry, AutopilotOverview, AutopilotPolicy, DeliveryDetails, DeliveryItem, EcosystemOverview, FeatureFlag, GrowthOverview, OperationTimeline, OperationsSummary, OutboxItem, Palette, ProvisioningJob, ReconciliationFinding, ReconciliationResult, RegionalProfile, RetryResult, TenantRuntimeSnapshot, TenantSummary } from './types'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-request-id': crypto.randomUUID(),
      ...(authState.authorization() ? { authorization: authState.authorization()! } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    if (response.status === 401) authState.clear()
    const body = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string }
    throw new ApiError(response.status, body.detail ?? `HTTP ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export type CreateTenantInput = {
  slug: string
  displayName: string
  workspaceId?: string
  crowdrelayBaseUrl?: string
  signalBaseUrl?: string
  defaultCountryCode?: string
  regionalProfile: RegionalProfile
  brandingPalette?: Palette
  deployCrowdrelay?: boolean
  desiredVersion?: string
}

export const api = {
  authenticate: async (username: string, password: string) => {
    authState.setBasic(username, password)
    try {
      await request('/overview')
    } catch (error) {
      authState.clear()
      throw error
    }
  },
  overview: () => request<{
    tenants: number
    healthy: number
    degraded: number
    stale: number
    unknown: number
    runtimeStaleAfterSeconds: number
    provisionerConfigured: boolean
    provisionerDefaultImageTag: string | null
  }>('/overview'),
  tenants: () => request<{ items: TenantSummary[] }>('/tenants'),
  tenant: (slug: string) => request<TenantSummary>(`/tenants/${encodeURIComponent(slug)}`),
  tenantRuntime: (slug: string) => request<TenantRuntimeSnapshot>(`/tenants/${encodeURIComponent(slug)}/runtime`),
  createTenant: (input: CreateTenantInput) =>
    request<TenantSummary>('/tenants', { method: 'POST', body: JSON.stringify(input) }),
  branding: (slug: string, brandingPalette: Palette | null) =>
    request<TenantSummary>(`/tenants/${encodeURIComponent(slug)}/branding`, { method: 'PATCH', body: JSON.stringify({ brandingPalette }) }),
  regionalProfile: (slug: string, regionalProfile: RegionalProfile) =>
    request<TenantSummary>(`/tenants/${encodeURIComponent(slug)}/regional-profile`, { method: 'PATCH', body: JSON.stringify({ regionalProfile }) }),
  suspend: (slug: string) => request<TenantSummary>(`/tenants/${encodeURIComponent(slug)}/suspend`, { method: 'POST', body: '{}' }),
  resume: (slug: string) => request<TenantSummary>(`/tenants/${encodeURIComponent(slug)}/resume`, { method: 'POST', body: '{}' }),
  planProvisioning: (slug: string, desiredVersion?: string) =>
    request<ProvisioningJob>(`/tenants/${encodeURIComponent(slug)}/provisioning/plan`, { method: 'POST', body: JSON.stringify({ desiredVersion: desiredVersion || undefined }) }),
  deployTenant: (slug: string, desiredVersion?: string) =>
    request<ProvisioningJob>(`/tenants/${encodeURIComponent(slug)}/provisioning/deploy`, { method: 'POST', body: JSON.stringify({ desiredVersion: desiredVersion || undefined }) }),
  provisioning: (slug: string) => request<{ items: ProvisioningJob[] }>(`/tenants/${encodeURIComponent(slug)}/provisioning`),
  cancelProvisioning: (slug: string) => request<ProvisioningJob>(`/tenants/${encodeURIComponent(slug)}/provisioning/cancel`, { method: 'POST', body: '{}' }),
  audit: (slug: string) => request<{ items: AuditEntry[] }>(`/tenants/${encodeURIComponent(slug)}/audit?limit=40`),
  operationsSummary: (slug: string) => request<OperationsSummary>(`/tenants/${encodeURIComponent(slug)}/operations/summary`),
  deadOutbox: (slug: string) => request<OutboxItem[]>(`/tenants/${encodeURIComponent(slug)}/operations/outbox/dead`),
  retryOutbox: (slug: string, id: string) => request<RetryResult>(`/tenants/${encodeURIComponent(slug)}/operations/outbox/${encodeURIComponent(id)}/retry`, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}',
  }),
  deadDeliveries: (slug: string) => request<DeliveryItem[]>(`/tenants/${encodeURIComponent(slug)}/operations/deliveries/dead`),
  deliveryDetails: (slug: string, id: string) => request<DeliveryDetails>(`/tenants/${encodeURIComponent(slug)}/operations/deliveries/${encodeURIComponent(id)}`),
  retryDelivery: (slug: string, id: string) => request<RetryResult>(`/tenants/${encodeURIComponent(slug)}/operations/deliveries/${encodeURIComponent(id)}/retry`, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}',
  }),
  clearDeadDeliveries: (slug: string) => request<{ operation_id: string; cleared: number; status: string; replayed: boolean }>(`/tenants/${encodeURIComponent(slug)}/operations/dead-deliveries/clear`, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}',
  }),
  operationTimeline: (slug: string, requestId: string) => request<OperationTimeline>(`/tenants/${encodeURIComponent(slug)}/operations/timeline/${encodeURIComponent(requestId)}`),
  ecosystemOverview: (slug: string) => request<EcosystemOverview>(`/tenants/${encodeURIComponent(slug)}/operations/ecosystem`),
  reconciliationFindings: (slug: string) => request<ReconciliationFinding[]>(`/tenants/${encodeURIComponent(slug)}/operations/findings`),
  runReconciliation: (slug: string) => request<ReconciliationResult>(`/tenants/${encodeURIComponent(slug)}/operations/reconcile`, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: '{}',
  }),
  featureFlags: (slug: string) => request<FeatureFlag[]>(`/tenants/${encodeURIComponent(slug)}/operations/flags`),
  setFeatureFlag: (slug: string, flag: FeatureFlag, enabled: boolean) => request<{flag: FeatureFlag; replayed: boolean}>(`/tenants/${encodeURIComponent(slug)}/operations/flags/${encodeURIComponent(flag.key)}`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ enabled, reason: 'Control Plane operator toggle', expected_version: flag.version }),
  }),
  autopilotOverview: (slug: string) => request<AutopilotOverview>(`/tenants/${encodeURIComponent(slug)}/operations/autopilot`),
  setAutopilotPolicy: (slug: string, policy: AutopilotPolicy, input: Pick<AutopilotPolicy, 'enabled'|'autonomy_level'|'minimum_confidence'|'max_actions_24h'>) => request<unknown>(`/tenants/${encodeURIComponent(slug)}/operations/autopilot/${encodeURIComponent(policy.context)}`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      enabled: input.enabled,
      autonomy_level: input.autonomy_level,
      minimum_confidence_basis_points: input.minimum_confidence,
      max_actions_24h: input.max_actions_24h,
      expected_version: policy.version,
    }),
  }),
  growthOverview: (slug: string) => request<GrowthOverview>(`/tenants/${encodeURIComponent(slug)}/operations/growth`),
  areaOverview: (slug: string) => request<AreaOverview>(`/tenants/${encodeURIComponent(slug)}/area`),
  areaSettings: (slug: string, enabled: boolean) => request<{enabled:boolean; entitled:boolean}>(`/tenants/${encodeURIComponent(slug)}/area/settings`, { method:'PATCH', body:JSON.stringify({enabled}) }),
  areaCities: (slug: string, q = '', limit = 30) => request<{items:AreaCity[]}>(`/tenants/${encodeURIComponent(slug)}/area/cities?q=${encodeURIComponent(q)}&limit=${limit}`),
  areaCreateCity: (slug:string, input:{slug:string;name:string;countryCode:string;region?:string;latitude:number;longitude:number}) => request<AreaCity>(`/tenants/${encodeURIComponent(slug)}/area/cities`, {method:'POST',body:JSON.stringify(input)}),
  areaDrops: (slug:string) => request<{items:AreaDropSummary[]}>(`/tenants/${encodeURIComponent(slug)}/area/drops`),
  areaDrop: (slug:string,id:string) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}`),
  areaCreateDrop: (slug:string,dropId:string,draft:AreaDropDraft) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops`, {method:'POST',body:JSON.stringify({dropId,draft})}),
  areaSaveDraft: (slug:string,id:string,baseRevision:number,draft:AreaDropDraft) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/draft`, {method:'PATCH',body:JSON.stringify({baseRevision,draft})}),
  areaDiscardDraft: (slug:string,id:string) => request<void>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/draft`, {method:'DELETE'}),
  areaValidate: (slug:string,id:string) => request<AreaValidationResult>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/validate`, {method:'POST',body:'{}'}),
  areaPublish: (slug:string,id:string,confirmations:string[] = []) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/publish`, {method:'POST',body:JSON.stringify({confirmations})}),
  areaPause: (slug:string,id:string) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/pause`, {method:'POST',body:'{}'}),
  areaResume: (slug:string,id:string) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/resume`, {method:'POST',body:'{}'}),
  areaArchive: (slug:string,id:string) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/archive`, {method:'POST',body:'{}'}),
  areaDuplicate: (slug:string,id:string,newDropId:string,cityId:string) => request<AreaDropDetail>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}/duplicate`, {method:'POST',body:JSON.stringify({newDropId,cityId})}),
  areaDelete: (slug:string,id:string) => request<void>(`/tenants/${encodeURIComponent(slug)}/area/drops/${encodeURIComponent(id)}`, {method:'DELETE'}),
}
