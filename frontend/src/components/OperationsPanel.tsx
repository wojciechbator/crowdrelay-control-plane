import { For, Show, createEffect, createSignal } from 'solid-js'
import { useQuery } from '@tanstack/solid-query'
import { api } from '../lib/api'
import type { AutopilotOverview, AutopilotPolicy, AutonomyLevel, FeatureFlag, OperationsSummary, RuntimeHealth } from '../lib/types'
import { StatusBadge } from './StatusBadge'

const errorMessage = (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback

const flagLabel = (key: string) => key
  .replace(/_enabled$/, '')
  .split('_')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ')

const contextLabel = (context: string) => context
  .split('_')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ')

const seconds = (value: number) => {
  if (value <= 0) return '—'
  if (value < 60) return `${value}s`
  if (value < 3600) return `${Math.round(value / 60)}m`
  return `${(value / 3600).toFixed(value < 36_000 ? 1 : 0)}h`
}

const metric = (value: number | undefined, suffix = '') => value == null ? '—' : `${value.toLocaleString()}${suffix}`

const oldestQueueAge = (summary: OperationsSummary | undefined) => summary
  ? Math.max(summary.outbox.oldest_pending_seconds, summary.deliveries.oldest_pending_seconds, summary.push.oldest_pending_seconds)
  : 0

const operationalTone = (summary: OperationsSummary | undefined): 'good'|'warn'|'bad'|'muted' => {
  if (!summary) return 'muted'
  const dead = summary.outbox.dead + summary.deliveries.dead + summary.push.dead
  if (summary.watchdog.critical_alerts > 0 || dead > 0) return 'bad'
  if (summary.watchdog.active_alerts > 0 || summary.http.p95_ms > 1000 || oldestQueueAge(summary) > 300) return 'warn'
  return 'good'
}

const operationalLabel = (summary: OperationsSummary | undefined) => {
  const tone = operationalTone(summary)
  return tone === 'good' ? 'healthy' : tone === 'warn' ? 'attention' : tone === 'bad' ? 'degraded' : 'loading'
}

const staleReleaseComponents = (overview: AutopilotOverview | undefined) => overview?.release_ledger.components.filter((component) => component.stale) ?? []
const releaseTone = (overview: AutopilotOverview | undefined): 'good'|'warn'|'bad'|'muted' => {
  const ledger = overview?.release_ledger
  if (!ledger) return 'muted'
  if (ledger.backend_sha_drift || ledger.executor_manifest_drift) return 'bad'
  if (ledger.missing_components.length > 0 || staleReleaseComponents(overview).length > 0) return 'warn'
  return 'good'
}
const releaseLabel = (overview: AutopilotOverview | undefined) => {
  const tone = releaseTone(overview)
  return tone === 'good' ? 'converged' : tone === 'warn' ? 'incomplete' : tone === 'bad' ? 'drift detected' : 'loading'
}
// "missing" is a real gap, not a placeholder: nothing has ever posted that
// component's production receipt. Name the reporter so the operator knows
// which pipeline to look at instead of guessing.
const MISSING_RELEASE_CAUSE: Record<string, string> = {
  'crowdrelay-api': 'crowdrelayctl deploy has not reported a receipt (needs CROWDRELAY_LEDGER_COMMERCE_API_KEY).',
  'crowdrelay-worker': 'crowdrelayctl deploy has not reported a receipt (needs CROWDRELAY_LEDGER_COMMERCE_API_KEY).',
  'virya-www': 'virya build.yml has not published a production receipt since the last deploy.',
  synesthesia: 'synesthesia deploy-web.yml has not published a production receipt since the last deploy.',
  'virya-signal': 'virya-signal mobile-release.yml has not published a production receipt since the last release.',
  n8n: 'scripts/publish-n8n-heartbeat.sh has not run against production yet.',
}
const missingReleaseCause = (key: string) =>
  MISSING_RELEASE_CAUSE[key] ?? 'No production release receipt reported yet.'

const releaseObserved = (value: string) => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'unknown time' : parsed.toLocaleString()
}

function PolicyEditor(props: {
  policy: AutopilotPolicy
  pending: boolean
  onSave: (input: Pick<AutopilotPolicy, 'enabled'|'autonomy_level'|'minimum_confidence'|'max_actions_24h'>) => Promise<void>
}) {
  const [enabled, setEnabled] = createSignal(props.policy.enabled)
  const [level, setLevel] = createSignal<AutonomyLevel>(props.policy.autonomy_level)
  const [confidence, setConfidence] = createSignal(props.policy.minimum_confidence / 100)
  const [maxActions, setMaxActions] = createSignal(props.policy.max_actions_24h)

  createEffect(() => {
    const policy = props.policy
    setEnabled(policy.enabled)
    setLevel(policy.autonomy_level)
    setConfidence(policy.minimum_confidence / 100)
    setMaxActions(policy.max_actions_24h)
  })

  const confidenceBasisPoints = () => Math.round(Math.max(0, Math.min(100, confidence())) * 100)
  const valid = () => Number.isFinite(confidence()) && confidence() >= 0 && confidence() <= 100 && Number.isInteger(maxActions()) && maxActions() >= 1 && maxActions() <= 1000
  const dirty = () => enabled() !== props.policy.enabled
    || level() !== props.policy.autonomy_level
    || confidenceBasisPoints() !== props.policy.minimum_confidence
    || maxActions() !== props.policy.max_actions_24h
  const guarded = () => props.policy.guarded_until && new Date(props.policy.guarded_until).getTime() > Date.now()

  return <div class="autopilot-policy-row">
    <div class="policy-name">
      <div class="row-health">
        <strong>{contextLabel(props.policy.context)}</strong>
        <Show when={guarded()}><StatusBadge status="guarded" tone="warn" /></Show>
      </div>
      <small>v{props.policy.version}{props.policy.guardrail_reason ? ` · ${props.policy.guardrail_reason}` : ''}</small>
    </div>
    <label class="compact-field policy-enabled">
      <span>Enabled</span>
      <button
        type="button"
        class={`switch-control ${enabled() ? 'on' : ''}`}
        role="switch"
        aria-checked={enabled()}
        aria-label={`${contextLabel(props.policy.context)} enabled`}
        disabled={props.pending}
        onClick={() => setEnabled((current) => !current)}
      ><span /></button>
    </label>
    <label class="compact-field">
      <span>Mode</span>
      <select disabled={props.pending} value={level()} onChange={(event) => setLevel(event.currentTarget.value as AutonomyLevel)}>
        <option value="observe">Observe</option>
        <option value="recommend">Recommend</option>
        <option value="require_approval">Require approval</option>
        <option value="bounded_auto">Bounded auto</option>
      </select>
    </label>
    <label class="compact-field policy-number">
      <span>Min confidence</span>
      <div class="number-suffix"><input disabled={props.pending} type="number" min="0" max="100" step="1" value={confidence()} onInput={(event) => setConfidence(event.currentTarget.valueAsNumber)} /><b>%</b></div>
    </label>
    <label class="compact-field policy-number">
      <span>Max / 24h</span>
      <input disabled={props.pending} type="number" min="1" max="1000" step="1" value={maxActions()} onInput={(event) => setMaxActions(event.currentTarget.valueAsNumber)} />
    </label>
    <button
      class="ghost policy-save"
      disabled={!dirty() || !valid() || props.pending}
      onClick={() => props.onSave({
        enabled: enabled(),
        autonomy_level: level(),
        minimum_confidence: confidenceBasisPoints(),
        max_actions_24h: maxActions(),
      })}
    >{props.pending ? 'Saving…' : 'Apply'}</button>
  </div>
}

export function OperationsPanel(props: { slug: string; runtimeHealth: RuntimeHealth; enabled: boolean }) {
  const summary = useQuery(() => ({
    queryKey: ['tenant-operations-summary', props.slug],
    queryFn: () => api.operationsSummary(props.slug),
    enabled: props.enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
  }))
  const flags = useQuery(() => ({
    queryKey: ['tenant-operations-flags', props.slug],
    queryFn: () => api.featureFlags(props.slug),
    enabled: props.enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    staleTime: 20_000,
  }))
  const autopilot = useQuery(() => ({
    queryKey: ['tenant-operations-autopilot', props.slug],
    queryFn: () => api.autopilotOverview(props.slug),
    enabled: props.enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    staleTime: 20_000,
  }))
  const [pendingMutation, setPendingMutation] = createSignal<string | null>(null)
  const [mutationError, setMutationError] = createSignal<string | null>(null)

  const mutate = async (key: string, operation: () => Promise<unknown>, refresh: () => Promise<unknown>) => {
    setMutationError(null)
    setPendingMutation(key)
    try {
      await operation()
      await refresh()
    } catch (error) {
      setMutationError(errorMessage(error, 'Tenant operation failed'))
    } finally {
      setPendingMutation(null)
    }
  }

  const updateFlag = (flag: FeatureFlag) => mutate(
    `flag:${flag.key}`,
    () => api.setFeatureFlag(props.slug, flag, !flag.enabled),
    () => flags.refetch(),
  )

  const updatePolicy = (policy: AutopilotPolicy, input: Pick<AutopilotPolicy, 'enabled'|'autonomy_level'|'minimum_confidence'|'max_actions_24h'>) => mutate(
    `policy:${policy.context}`,
    () => api.setAutopilotPolicy(props.slug, policy, input),
    () => autopilot.refetch(),
  )

  const unavailable = () => summary.error || flags.error || autopilot.error
  const deadJobs = () => summary.data ? summary.data.outbox.dead + summary.data.deliveries.dead + summary.data.push.dead : 0

  return <article class="panel operations-panel">
    <div class="section-title operations-title">
      <div><span class="eyebrow">OPERATIONS</span><h2>Health & controls</h2><p>Live CrowdRelay telemetry and bounded runtime controls. Changes are tenant-scoped and audited.</p></div>
      <div class="row-health">
        <StatusBadge status={props.runtimeHealth} tone={props.runtimeHealth === 'healthy' ? 'good' : props.runtimeHealth === 'degraded' ? 'bad' : props.runtimeHealth === 'stale' ? 'warn' : 'muted'} />
        <StatusBadge status={operationalLabel(summary.data)} tone={operationalTone(summary.data)} />
      </div>
    </div>

    <Show when={!props.enabled}>
      <div class="inherit-card"><p>Operational controls become available after the tenant is active and its private management channel is configured.</p></div>
    </Show>

    <Show when={props.enabled}>
      <Show when={unavailable()}>
        <div class="warning-card operations-warning" role="status">
          Operational channel is partially unavailable. Existing tenant runtime telemetry remains visible above; private p95, feature and Autopilot controls will recover automatically.
        </div>
      </Show>
      <Show when={mutationError()}>{message => <div class="error-card operations-error" role="alert">{message()}</div>}</Show>

      <div class="operations-metrics">
        <div><span>HTTP p95</span><strong>{metric(summary.data?.http.p95_ms, ' ms')}</strong><small>p50 {metric(summary.data?.http.p50_ms, ' ms')}</small></div>
        <div><span>Outbox pending</span><strong>{metric(summary.data?.outbox.pending)}</strong><small>{summary.data ? `${summary.data.outbox.processing} processing` : '—'}</small></div>
        <div><span>Delivery pending</span><strong>{metric(summary.data?.deliveries.pending)}</strong><small>{summary.data ? `${summary.data.deliveries.dead} dead` : '—'}</small></div>
        <div><span>Push pending</span><strong>{metric(summary.data?.push.pending)}</strong><small>{summary.data ? `${summary.data.push.dead} dead` : '—'}</small></div>
        <div><span>Oldest queue</span><strong>{summary.data ? seconds(oldestQueueAge(summary.data)) : '—'}</strong><small>across async queues</small></div>
        <div><span>Watchdog</span><strong>{metric(summary.data?.watchdog.active_alerts)}</strong><small>{summary.data ? `${summary.data.watchdog.critical_alerts} critical` : '—'}</small></div>
      </div>

      <Show when={summary.data && (deadJobs() > 0 || summary.data.watchdog.critical_alerts > 0)}>
        <div class="operations-attention"><strong>Operator attention required</strong><span>{deadJobs()} dead queue item(s) · {summary.data?.watchdog.critical_alerts ?? 0} critical watchdog alert(s)</span></div>
      </Show>

      <section class="operations-section ecosystem-release-section">
        <div class="operations-section-head">
          <div><span class="eyebrow">ECOSYSTEM RELEASE</span><h3>Production convergence</h3><p>Every expected production component reports its own release receipt. Missing or stale receipts stay visible until the component converges.</p></div>
          <StatusBadge status={releaseLabel(autopilot.data)} tone={releaseTone(autopilot.data)} />
        </div>
        <Show when={autopilot.data?.release_ledger} fallback={<div class="mini-skeleton"/>}>{ledger => <>
          <div class="autopilot-kpis">
            <div><strong>{ledger().components.length}</strong><span>reported components</span></div>
            <div><strong>{ledger().missing_components.length}</strong><span>missing</span></div>
            <div><strong>{staleReleaseComponents(autopilot.data).length}</strong><span>stale</span></div>
            <div><strong>{ledger().active_executor_count}</strong><span>active executors</span></div>
          </div>
          <Show when={ledger().backend_sha_drift || ledger().executor_manifest_drift || ledger().missing_components.length > 0 || staleReleaseComponents(autopilot.data).length > 0}>
            <div class="operations-attention">
              <strong>Release reconciliation needs attention</strong>
              <span>{[
                ledger().backend_sha_drift ? 'API/worker SHA drift' : '',
                ledger().executor_manifest_drift ? 'executor manifest drift' : '',
                ledger().missing_components.length ? `${ledger().missing_components.length} component(s) have no release receipt` : '',
                staleReleaseComponents(autopilot.data).length ? `${staleReleaseComponents(autopilot.data).length} component(s) are stale` : '',
              ].filter(Boolean).join(' · ')}</span>
            </div>
          </Show>
          <div class="flag-list release-component-list">
            <For each={ledger().components}>{component => <div class="flag-row release-component-row">
              <div>
                <strong>{component.component_key}</strong>
                <small>{component.environment} · {component.source_sha.slice(0, 12)} · {releaseObserved(component.observed_at)}</small>
                <Show when={component.deploy_ref || component.version}><small>{component.version ?? 'unversioned'}{component.deploy_ref ? ` · ${component.deploy_ref}` : ''}</small></Show>
              </div>
              <div class="row-health">
                <Show when={component.artifact_digest}><code title={component.artifact_digest ?? undefined}>{component.artifact_digest?.slice(0, 20)}…</code></Show>
                <StatusBadge status={component.stale ? 'stale' : 'current'} tone={component.stale ? 'warn' : 'good'} />
              </div>
            </div>}</For>
            <For each={ledger().missing_components}>{componentKey => <div class="flag-row release-component-row release-component-missing">
              <div>
                <strong>{componentKey}</strong>
                <small>{missingReleaseCause(componentKey)}</small>
              </div>
              <div class="row-health"><StatusBadge status="missing" tone="warn" /></div>
            </div>}</For>
          </div>
          <div class="rum-grid">
            <div><strong>{ledger().team_email_live ? 'live' : 'not live'}</strong><span>team.email</span><small>{ledger().active_team_email_executor_count} capable executor(s)</small></div>
            <div><strong>{ledger().n8n_attestation_ready ? 'verified' : 'missing'}</strong><span>n8n attestation</span><small>{ledger().guarded_executor_count} guarded executor(s)</small></div>
            <div><strong>{ledger().active_executor_manifest_shas.length}</strong><span>executor manifests</span><small>{ledger().executor_manifest_drift ? 'drift detected' : 'converged'}</small></div>
          </div>
        </>}</Show>
      </section>

      <div class="operations-split">
        <section class="operations-section">
          <div class="operations-section-head"><div><span class="eyebrow">FEATURES</span><h3>Runtime switches</h3></div><small>{flags.data?.length ?? 0} declared</small></div>
          <Show when={flags.data} fallback={<div class="mini-skeleton"/>}>{items => <div class="flag-list">
            <For each={items()}>{flag => <div class="flag-row">
              <div><strong>{flagLabel(flag.key)}</strong><small>{flag.reason || `v${flag.version} · no override reason`}</small></div>
              <button
                type="button"
                class={`switch-control ${flag.enabled ? 'on' : ''}`}
                role="switch"
                aria-checked={flag.enabled}
                aria-label={`${flagLabel(flag.key)} ${flag.enabled ? 'enabled' : 'disabled'}`}
                disabled={pendingMutation() !== null}
                onClick={() => updateFlag(flag)}
              ><span /></button>
            </div>}</For>
          </div>}</Show>
        </section>

        <section class="operations-section autopilot-section">
          <div class="operations-section-head">
            <div><span class="eyebrow">AUTOPILOT</span><h3>Authority policies</h3></div>
            <StatusBadge status={autopilot.data?.runtime_enabled ? 'runtime on' : 'runtime off'} tone={autopilot.data?.runtime_enabled ? 'good' : 'muted'} />
          </div>
          <Show when={autopilot.data} fallback={<div class="mini-skeleton"/>}>{data => <>
            <div class="autopilot-kpis">
              <div><strong>{data().needs_you.length}</strong><span>needs you</span></div>
              <div><strong>{data().queued_actions}</strong><span>queued</span></div>
              <div><strong>{data().failed_24h}</strong><span>failed 24h</span></div>
              <div><strong>{data().executor_failed_24h}</strong><span>executor fail</span></div>
            </div>
            <div class="autopilot-policy-list">
              <For each={data().policies}>{policy => <PolicyEditor
                policy={policy}
                pending={pendingMutation() !== null}
                onSave={(input) => updatePolicy(policy, input) as Promise<void>}
              />}</For>
            </div>
            <Show when={data().rum_metrics_24h.length > 0}>
              <div class="rum-grid">
                <For each={data().rum_metrics_24h.slice(0, 6)}>{rum => <div><strong>{contextLabel(rum.metric_key)}</strong><span>{rum.surface} · {rum.samples_24h} samples</span><small>p75 {rum.p75.toFixed(1)} · p95 {rum.p95.toFixed(1)}</small></div>}</For>
              </div>
            </Show>
          </>}</Show>
        </section>
      </div>
    </Show>
  </article>
}