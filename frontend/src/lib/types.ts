export type Palette = {
  primary: string
  primaryContrast: string
  accent: string
  surface: string
  surfaceElevated: string
  text: string
  textMuted: string
  success: string
  warning: string
  danger: string
}

export type RegionalProfile = {
  countryCode: string
  region: 'eu' | 'us'
  locale: string
  timezone: string
  currency: string
  dateFormat: 'dmy' | 'mdy' | 'ymd'
  numberFormat: 'comma_decimal' | 'dot_decimal'
  dataRegion: 'eu' | 'us'
}

export type RuntimeStatus = {
  tenantId: string
  apiHealthy: boolean | null
  workerHealthy: boolean | null
  schemaVersion: number | null
  deployedSha: string | null
  outboxPending: number | null
  queueLag: number | null
  lastHeartbeatAt: string | null
  checkedAt: string | null
}

export type Tenant = {
  id: string
  slug: string
  displayName: string
  status: 'provisioning' | 'active' | 'suspended'
  workspaceId: string | null
  crowdrelayBaseUrl: string | null
  signalBaseUrl: string | null
  defaultCountryCode: string
  regionalProfile: RegionalProfile | null
  brandingPalette: Palette | null
  synesthesiaEnabled: boolean
  areaEnabled: boolean
  createdAt: string
  updatedAt: string
}

export type RuntimeHealth = 'healthy' | 'degraded' | 'stale' | 'unknown'

export type TenantSummary = Tenant & { runtime: RuntimeStatus | null; runtimeHealth: RuntimeHealth }
export type TenantRuntimeSnapshot = { runtime: RuntimeStatus | null; runtimeHealth: RuntimeHealth }

export type AuditEntry = {
  id: string
  tenantId: string | null
  actor: string
  action: string
  targetKind: string
  targetId: string
  requestId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

export type ProvisioningResult = {
  apiPort?: number
  localApiUrl?: string
  workspaceId?: string
  schemaVersion?: number
  deployedSha?: string
  provisionerWorkerId?: string
  dataRegion?: 'eu' | 'us' | null
  completedAt?: string
}

export type ProvisioningJob = {
  id: string
  tenantId: string
  status: 'planned' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  desiredVersion: string | null
  plan: Record<string, unknown>
  createdBy: string
  attemptCount: number
  claimedBy: string | null
  leaseExpiresAt: string | null
  startedAt: string | null
  finishedAt: string | null
  result: ProvisioningResult | null
  errorCode: string | null
  errorDetail: string | null
  createdAt: string
  updatedAt: string
}

export type AreaStatus = 'DRAFT' | 'PAUSED' | 'SCHEDULED' | 'LIVE' | 'ENDED' | 'ARCHIVED'
export type AreaCity = { id:string; slug:string; name:string; countryCode:string; region:string|null; latitude:number|null; longitude:number|null; moderationStatus:string }
export type AreaClue = { en:string; pl:string }
export type AreaCollectible = { line:string; track:string; edition:string; riddle:string }
export type AreaDropDraft = {
  number:string; cityId:string; mapX:number; mapY:number
  approximateLat:number; approximateLng:number; exactLat:number|null; exactLng:number|null
  radiusMeters:number; maxClaims:number; startsAt:string; endsAt:string
  clue:AreaClue; collectible:AreaCollectible; sortOrder:number
}
export type AreaDropSummary = {
  id:string; number:string; cityId:string; city:string; region:string; status:AreaStatus; active:boolean
  revision:number; hasDraft:boolean; hasExactLocation:boolean; claimCount:number; maxClaims:number
  startsAt:string; endsAt:string
}
export type AreaDropDetail = { summary:AreaDropSummary; published:AreaDropDraft; draft:AreaDropDraft|null; draftBaseRevision:number|null }
export type AreaOverview = {
  enabled:boolean; entitled:boolean; total:number; live:number; scheduled:number; drafts:number
  ended:number; paused:number; archived:number; totalClaims:number
}
export type AreaValidationIssue = { code:string; field:string; message:string; confirmationRequired:boolean }
export type AreaValidationResult = { valid:boolean; issues:AreaValidationIssue[] }

export type OperationsQueueSummary = {
  pending: number
  processing: number
  delivered_24h: number
  dead: number
  cancelled: number
  oldest_pending_seconds: number
}

export type DatabaseRuntimeSummary = {
  pool_size: number
  pool_idle: number
  pool_max: number
  server_version_num: number
  io_method: string | null
  io_workers: number | null
  io_max_concurrency: number | null
  effective_io_concurrency: number | null
  maintenance_io_concurrency: number | null
  io_combine_limit_bytes: number | null
  io_max_combine_limit_bytes: number | null
  async_io_active: boolean
}

export type AreaRuntimeSummary = {
  credits_total: number
  vouchers_issued: number
  stale_voucher_reservations: number
  ticket_rewards_issued: number
  stale_ticket_reward_reservations: number
  legacy_imported_players: number
}

export type OperationsSummary = {
  outbox: OperationsQueueSummary
  deliveries: OperationsQueueSummary
  push: OperationsQueueSummary
  watchdog: { active_alerts: number; critical_alerts: number; last_observed_at: string | null }
  http: { requests: number; errors_4xx: number; errors_5xx: number; average_ms: number; p50_ms: number; p95_ms: number }
  database: DatabaseRuntimeSummary
  area: AreaRuntimeSummary
  schema_version: number
  release: string
}

export type OutboxItem = {
  id: string
  event_type: string
  event_version: number
  status: string
  attempts: number
  max_attempts: number
  available_at: string
  last_error_kind: string | null
  created_at: string
  updated_at: string
  delivered_at: string | null
  dead_at: string | null
}

export type DeliveryItem = {
  id: string
  outbox_event_id: string
  event_type: string
  endpoint_name: string
  endpoint_active: boolean
  status: string
  attempt_count: number
  max_attempts: number
  available_at: string
  last_response_status: number | null
  last_error_kind: string | null
  created_at: string
  updated_at: string
  delivered_at: string | null
  dead_at: string | null
}

export type DeliveryAttempt = {
  attempt_number: number
  started_at: string
  finished_at: string
  outcome: string
  response_status: number | null
  error_kind: string | null
  duration_ms: number
}

export type DeliveryDetails = { delivery: DeliveryItem; attempts: DeliveryAttempt[] }

export type RetryResult = {
  operation_id: string
  target_type: string
  target_id: string
  status: string
  replayed: boolean
}

export type OperationTimelineEvent = {
  occurred_at: string
  source: string
  kind: string
  status: string | null
  target_type: string | null
  target_id: string | null
}

export type OperationTimeline = { request_id: string; events: OperationTimelineEvent[] }

export type ReconciliationRun = {
  id: string
  status: string
  trigger: string
  finding_count: number
  started_at: string
  finished_at: string | null
}

export type ReconciliationFinding = {
  id: string
  run_id: string
  kind: string
  severity: 'info' | 'warning' | 'critical' | string
  entity_type: string
  entity_id: string | null
  entity_label: string | null
  summary: string
  suggested_action: string | null
  metadata: Record<string, unknown>
  created_at: string
  resolved_at: string | null
}

export type EcosystemOverview = {
  schema_version: number
  flags: FeatureFlag[]
  last_reconciliation: ReconciliationRun | null
  open_findings: number
  next_event: { id: string; slug: string; title: string; venue: string | null; starts_at: string } | null
  bandsintown_sync: {
    last_synced_at: string | null
    last_success_at: string | null
    next_sync_at: string
    consecutive_failures: number
    last_error: string | null
    in_progress: boolean
  } | null
}

export type ReconciliationResult = {
  run: ReconciliationRun
  findings: ReconciliationFinding[]
  replayed: boolean
}

export type FeatureFlag = {
  key: string
  enabled: boolean
  reason: string | null
  version: number
  updated_at: string
}

export type AutonomyLevel = 'observe' | 'recommend' | 'require_approval' | 'bounded_auto'

export type AutopilotPolicy = {
  context: string
  enabled: boolean
  autonomy_level: AutonomyLevel
  minimum_confidence: number
  max_actions_24h: number
  version: number
  guarded_until: string | null
  guardrail_reason: string | null
}

export type RumMetric = {
  surface: string
  metric_key: string
  samples_24h: number
  p75: number
  p95: number
}

export type ReleaseComponentSummary = {
  component_key: string
  environment: string
  source_sha: string
  artifact_digest: string | null
  deploy_ref: string | null
  version: string | null
  manifest_sha: string | null
  dependency_lock_sha256: string | null
  artifact_manifest_sha256: string | null
  workflow_attestation_sha: string | null
  workflow_attested_at: string | null
  observed_at: string
  stale: boolean
}

export type ReleaseLedgerOverview = {
  components: ReleaseComponentSummary[]
  missing_components: string[]
  backend_sha_drift: boolean
  executor_manifest_drift: boolean
  active_executor_count: number
  guarded_executor_count: number
  active_executor_manifest_shas: string[]
  active_team_email_executor_count: number
  n8n_attestation_ready: boolean
  team_email_live: boolean
}

export type AutopilotOverview = {
  runtime_enabled: boolean
  policies: AutopilotPolicy[]
  needs_you: unknown[]
  queued_actions: number
  processing_actions: number
  succeeded_24h: number
  failed_24h: number
  executor_confirmed_24h: number
  executor_failed_24h: number
  awaiting_executor: number
  release_ledger: ReleaseLedgerOverview
  rum_metrics_24h: RumMetric[]
}

export type GrowthCampaignProgress = {
  campaign_id: string
  slug: string
  name: string
  template_key: string
  status: string
  scheduled_at: string | null
  completed_at: string | null
  recipient_count: number
  delivered_count: number
  failed_count: number
  claimed_count: number
  pending_count: number
  stalled: boolean
}

export type GrowthDeliveryTotals = {
  scheduled_campaigns: number
  completed_campaigns: number
  cancelled_campaigns: number
  delivered: number
  failed: number
  pending: number
  claimed: number
  stalled_campaigns: number
}

export type GrowthOutreachSummary = {
  active_opportunities: number
  playlist_opportunities: number
  awaiting_reply: number
  replies_14d: number
  eligible_playlist_targets: number
  suppressed_targets: number
}

export type GrowthOverview = {
  campaigns_enabled: boolean
  totals: GrowthDeliveryTotals
  outreach: GrowthOutreachSummary
  campaigns: GrowthCampaignProgress[]
}
