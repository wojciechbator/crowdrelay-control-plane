import { For, Show, createEffect, createSignal } from 'solid-js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'
import { Link, useParams } from '@tanstack/solid-router'
import { api } from '../lib/api'
import type { Palette, ProvisioningJob } from '../lib/types'
import { StatusBadge } from '../components/StatusBadge'
import { RegionalProfilePanel } from '../components/RegionalProfilePanel'
import { OperationsPanel } from '../components/OperationsPanel'
import { GrowthPanel } from '../components/GrowthPanel'
import { TenantRuntimePanel } from '../components/TenantRuntimePanel'

const paletteFields: Array<keyof Palette> = ['primary','primaryContrast','accent','surface','surfaceElevated','text','textMuted','success','warning','danger']
const defaultPalette: Palette = { primary:'#8b5cf6', primaryContrast:'#ffffff', accent:'#22d3ee', surface:'#0b0c0f', surfaceElevated:'#15171c', text:'#f7f7f8', textMuted:'#9ca3af', success:'#22c55e', warning:'#f59e0b', danger:'#ef4444' }
const provisionTone = (status: ProvisioningJob['status']) => status === 'succeeded' ? 'good' : status === 'failed' ? 'bad' : status === 'cancelled' ? 'muted' : 'warn'
const errorMessage = (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback
const formatTimestamp = (value: string | null | undefined) => {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}
// The provisioner reports machine-readable failure codes. An operator deciding
// whether to retry needs to know which failures are safe to retry and which mean
// the release itself is untrustworthy, so each code carries explicit guidance
// rather than being surfaced as a bare identifier.
const provisionFailures: Record<string, { title: string; guidance: string; retryable: boolean }> = {
  image_revision_mismatch: { title: 'Image was built from a different commit', guidance: 'The published image does not carry the git SHA this release asked for. The tag was rebuilt or overwritten. Do not retry until the release is republished from the intended commit.', retryable: false },
  image_revision_missing: { title: 'Image is missing its provenance label', guidance: 'The image does not publish org.opencontainers.image.revision, so its origin cannot be verified. Republish it from CrowdRelay CI.', retryable: false },
  image_digest_changed: { title: 'Release now points at different bytes', guidance: 'This release identifier previously resolved to another image digest. The tag was re-pushed. Deployment stopped before starting the new image; investigate the registry before retrying.', retryable: false },
  image_digest_unresolved: { title: 'Image has no registry digest', guidance: 'The pulled image could not be resolved to an immutable digest. Confirm the image exists in the registry and was pulled, not built locally.', retryable: false },
  data_region_mismatch: { title: 'Wrong regional provisioner', guidance: 'This agent is not allowed to deploy the tenant data region. Route the job to the matching EU/US provisioner pool.', retryable: true },
  image_digest_ambiguous: { title: 'Image resolves to multiple digests', guidance: 'Several registry digests match this repository. Clean the local image cache on the provisioner host and retry.', retryable: true },
  image_pull_failed: { title: 'Image pull failed', guidance: 'The provisioner host could not pull the image. Check registry credentials and network from that host, then retry.', retryable: true },
  lease_lost: { title: 'Deployment lost its lease', guidance: 'Another provisioner reclaimed this job mid-deployment, so this agent stopped rather than keep mutating Docker state. Safe to retry.', retryable: true },
  port_pool_exhausted: { title: 'No free tenant port', guidance: 'Every port in the configured range is allocated. Widen the range or release a retired tenant, then retry.', retryable: false },
  port_allocation_conflict: { title: 'Tenant port is double-claimed', guidance: 'Two tenants recorded the same host port. Resolve the conflicting deployment record on the host before retrying.', retryable: false },
  api_readiness_timeout: { title: 'CrowdRelay API never became ready', guidance: 'The stack started but its readiness probe never passed. Inspect the tenant container logs on the host. Retrying is safe.', retryable: true },
  worker_readiness_timeout: { title: 'CrowdRelay worker never became healthy', guidance: 'The API became ready but the background worker health check did not. Inspect the worker logs on the provisioner host before retrying.', retryable: true },
  workspace_probe_failed: { title: 'Workspace was not created', guidance: 'Bootstrap finished without producing the expected workspace. Inspect the setup container output before retrying.', retryable: true },
  schema_probe_failed: { title: 'Migration state is unreadable', guidance: 'The schema version probe did not return an integer. Inspect the tenant database before retrying.', retryable: true },
  docker_compose_failed: { title: 'Docker Compose step failed', guidance: 'A Compose step exited non-zero. The provisioner log holds the bounded output tail for this deployment.', retryable: true },
  docker_compose_unavailable: { title: 'Docker is unavailable', guidance: 'The provisioner host could not run Docker Compose, or the step timed out. Check the host daemon, then retry.', retryable: true },
  invalid_plan: { title: 'Deployment plan was rejected', guidance: 'The agent refused the plan as unsafe or malformed. This is a Control Plane defect; the plan must be corrected before retrying.', retryable: false },
}

export function TenantPage() {
  const params = useParams({ from: '/tenants/$slug' })
  const queryClient = useQueryClient()
  // Tenant identity/configuration is page state, not telemetry. Once loaded it
  // stays mounted; live runtime queries are owned by small child surfaces.
  const tenant = useQuery(() => ({
    queryKey: ['tenant', params().slug],
    queryFn: () => api.tenant(params().slug),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }))
  const overview = useQuery(() => ({ queryKey: ['overview'], queryFn: api.overview }))
  const audit = useQuery(() => ({ queryKey: ['tenant-audit', params().slug], queryFn: () => api.audit(params().slug), refetchInterval: 15_000 }))
  const provisioning = useQuery(() => ({ queryKey: ['tenant-provisioning', params().slug], queryFn: () => api.provisioning(params().slug), refetchInterval: 3_000 }))
  const [palette, setPalette] = createSignal<Palette>(defaultPalette)
  const [editingPalette, setEditingPalette] = createSignal(false)
  const [desiredVersion, setDesiredVersion] = createSignal('')
  const [preview, setPreview] = createSignal<ProvisioningJob | null>(null)
  createEffect(() => { if (tenant.data?.brandingPalette) setPalette(tenant.data.brandingPalette) })

  const refreshTenant = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tenant', params().slug] }),
      queryClient.invalidateQueries({ queryKey: ['tenant-runtime', params().slug] }),
      queryClient.invalidateQueries({ queryKey: ['tenant-provisioning', params().slug] }),
      queryClient.invalidateQueries({ queryKey: ['tenant-audit', params().slug] }),
      queryClient.invalidateQueries({ queryKey: ['overview'] }),
    ])
  }
  const branding = useMutation(() => ({ mutationFn: (value: Palette | null) => api.branding(params().slug, value), onSuccess: refreshTenant }))
  const status = useMutation(() => ({ mutationFn: (action: 'suspend'|'resume') => action === 'suspend' ? api.suspend(params().slug) : api.resume(params().slug), onSuccess: refreshTenant }))
  const plan = useMutation(() => ({ mutationFn: () => api.planProvisioning(params().slug, desiredVersion() || overview.data?.provisionerDefaultImageTag || undefined), onSuccess: (job) => setPreview(job) }))
  const deploy = useMutation(() => ({ mutationFn: () => api.deployTenant(params().slug, desiredVersion()), onSuccess: async () => { setPreview(null); await refreshTenant() } }))
  const cancel = useMutation(() => ({ mutationFn: () => api.cancelProvisioning(params().slug), onSuccess: refreshTenant }))
  const latestJob = () => provisioning.data?.items[0]
  const deploymentBusy = () => ['planned', 'approved', 'running'].includes(latestJob()?.status ?? '')
  const requestedVersion = () => desiredVersion().trim() || overview.data?.provisionerDefaultImageTag || ''
  const releaseReady = () => /^sha-[0-9a-f]{40}$/.test(requestedVersion())

  return <section class="page">
    <Show when={tenant.error}><div class="error-card" role="alert">{errorMessage(tenant.error, 'Tenant could not be loaded')}</div></Show>
    <Show when={!tenant.error && tenant.data} fallback={!tenant.error ? <div class="skeleton-block"/> : null}>{data => {
    const t = data()
    return <>
      <div class="page-head">
        <div><span class="eyebrow">TENANT / {t.slug.toUpperCase()}</span><h1>{t.displayName}</h1><p>{t.workspaceId ?? 'Workspace mapping pending'} · {t.defaultCountryCode}</p></div>
        <div class="row-health"><StatusBadge status={t.status} tone={t.status === 'active' ? 'good' : t.status === 'suspended' ? 'bad' : 'warn'} />{t.slug !== 'virya' && <button class="ghost" onClick={() => status.mutate(t.status === 'suspended' ? 'resume' : 'suspend')}>{t.status === 'suspended' ? 'Resume' : 'Suspend'}</button>}</div>
      </div>
      <Show when={status.error || branding.error || plan.error || deploy.error || cancel.error || overview.error || audit.error || provisioning.error}>
        <div class="error-card" role="alert">{errorMessage(status.error || branding.error || plan.error || deploy.error || cancel.error || overview.error || audit.error || provisioning.error, 'Control Plane operation failed')}</div>
      </Show>
      <div class="detail-grid">
        <TenantRuntimePanel slug={t.slug} initial={{ runtime: t.runtime, runtimeHealth: t.runtimeHealth }} />
        <article class="panel products-panel">
          <span class="eyebrow">PRODUCTS</span><h2>Entitlements</h2>
          <div class="product-row product-entitlement-row"><strong>CrowdRelay</strong><div class="product-action-slot" aria-hidden="true"/><div class="product-status-slot"><StatusBadge status="enabled" tone="good" /></div></div>
          <div class="product-row product-entitlement-row"><strong>Signal</strong><div class="product-action-slot" aria-hidden="true"/><div class="product-status-slot"><StatusBadge status="enabled" tone="good" /></div></div>
          <div class="product-row product-entitlement-row"><strong>AREA</strong><div class="product-action-slot"><Link class="ghost area-link-button" to="/tenants/$slug/area" params={{slug:t.slug}}>Manage</Link></div><div class="product-status-slot"><StatusBadge status={t.areaEnabled ? 'enabled' : 'disabled'} tone={t.areaEnabled ? 'good' : 'muted'} /></div></div>
          <div class="product-row product-entitlement-row"><strong>Synesthesia</strong><div class="product-action-slot" aria-hidden="true"/><div class="product-status-slot"><StatusBadge status={t.synesthesiaEnabled ? 'Virya only' : 'not available'} tone={t.synesthesiaEnabled ? 'warn' : 'muted'} /></div></div>
        </article>
      </div>
      <OperationsPanel slug={t.slug} runtimeHealth={t.runtimeHealth} enabled={t.status === 'active'} />
      <GrowthPanel slug={t.slug} enabled={t.status === 'active'} />
      <RegionalProfilePanel tenant={t} />
      <article class="panel"><div class="section-title"><div><span class="eyebrow">BRANDING</span><h2>CrowdRelay + Signal palette</h2></div>{t.brandingPalette ? <button class="ghost" onClick={() => branding.mutate(null)}>Reset to product defaults</button> : <StatusBadge status="Inherits current product defaults" />}</div><Show when={t.brandingPalette || editingPalette()} fallback={<div class="inherit-card"><p>No palette is stored for this tenant. CrowdRelay and Signal therefore keep their own current default colors with zero theming lookup required.</p><button class="ghost" onClick={() => setEditingPalette(true)}>Create custom palette</button></div>}><div class="palette-grid"><For each={paletteFields}>{field => <label>{field}<div class="color-input"><input type="color" value={palette()[field]} onInput={(e) => setPalette(current => ({ ...current, [field]: e.currentTarget.value }))}/><code>{palette()[field]}</code></div></label>}</For></div><button onClick={() => branding.mutate(palette())} disabled={branding.isPending}>Save custom palette</button></Show></article>

      <article class="panel provisioning-panel">
        <div class="section-title">
          <div><span class="eyebrow">PROVISIONING</span><h2>CrowdRelay instance</h2></div>
          <Show when={latestJob()}>{job => <StatusBadge status={job().status} tone={provisionTone(job().status)} />}</Show>
        </div>
        <Show when={t.slug !== 'virya'} fallback={<div class="inherit-card"><p>Virya stays on the existing production CrowdRelay deployment. The tenant provisioner intentionally refuses to create a second Virya stack.</p></div>}>
          <p>The browser only requests desired state. A separately authenticated host agent claims the job and runs a fixed Docker Compose recipe; the Control Plane API never receives Docker access.</p>
          <div class="deployment-target-grid">
            <div><span>Public API</span><strong>{t.crowdrelayBaseUrl ?? 'not configured'}</strong></div>
            <div><span>Signal / site</span><strong>{t.signalBaseUrl ?? 'not configured'}</strong></div>
            <div><span>Provisioner</span><strong>{overview.data?.provisionerConfigured ? 'configured' : 'not configured'}</strong></div>
            <div><span>Default release</span><strong class="mono">{overview.data?.provisionerDefaultImageTag?.slice(0, 16) ?? 'not configured'}</strong></div>
          </div>
          <div class="provision-row">
            <input class={!releaseReady() && desiredVersion().trim() ? 'input-invalid mono' : 'mono'} value={desiredVersion()} onInput={(e) => setDesiredVersion(e.currentTarget.value)} placeholder={overview.data?.provisionerDefaultImageTag ?? 'sha-<40-char CrowdRelay commit>'} aria-invalid={!releaseReady() && Boolean(desiredVersion().trim())} />
            <button class="ghost" onClick={() => plan.mutate()} disabled={plan.isPending || deploymentBusy() || !releaseReady()}>Preview</button>
            <button onClick={() => deploy.mutate()} disabled={deploy.isPending || deploymentBusy() || !releaseReady() || t.status === 'suspended' || !t.crowdrelayBaseUrl || !t.signalBaseUrl}>{latestJob()?.status === 'failed' ? 'Retry deploy' : t.status === 'active' ? 'Deploy / upgrade' : 'Deploy instance'}</button>
          </div>
          <Show when={deploy.error}><div class="error-card">{deploy.error instanceof Error ? deploy.error.message : 'Deployment request failed'}</div></Show>
          <Show when={preview()}>{job => <div class="plan-preview"><span class="eyebrow">PLAN PREVIEW</span><pre>{JSON.stringify(job().plan, null, 2)}</pre></div>}</Show>
          <Show when={latestJob()}>{job => <div class="provision-job">
            <div class="provision-job-head"><div><strong>{job().desiredVersion ?? 'default release'}</strong><small>attempt {job().attemptCount} · created {new Date(job().createdAt).toLocaleString()}</small></div><StatusBadge status={job().status} tone={provisionTone(job().status)} /></div>
            <Show when={job().status === 'approved'}><p>Queued for the provisioner agent. No Docker mutation happens in the HTTP request.</p></Show>
            <Show when={job().status === 'running'}><p>Claimed by <code>{job().claimedBy ?? 'provisioner'}</code>. Lease expires {formatTimestamp(job().leaseExpiresAt)}.</p></Show>
            <Show when={job().status === 'succeeded'}><div class="deployment-result"><dl><dt>Local API</dt><dd><code>{job().result?.localApiUrl ?? '—'}</code></dd><dt>Host port</dt><dd>{job().result?.apiPort ?? '—'}</dd><dt>Workspace</dt><dd class="mono">{job().result?.workspaceId ?? t.workspaceId ?? '—'}</dd><dt>Schema</dt><dd>{job().result?.schemaVersion ?? '—'}</dd><dt>Provisioner</dt><dd><code>{job().result?.provisionerWorkerId ?? job().claimedBy ?? '—'}</code></dd></dl><p class="route-note">The instance is healthy locally. Route <code>{t.crowdrelayBaseUrl}</code> at the edge to this host port to expose it publicly.</p></div></Show>
            <Show when={job().status === 'failed' ? (job().errorCode ?? 'provisioning_failed') : undefined}>{code => <div class="error-card">
              <strong>{provisionFailures[code()]?.title ?? code()}</strong>
              <Show when={provisionFailures[code()]}>{failure => <>
                <p>{failure().guidance}</p>
                <Show when={!failure().retryable}><p class="route-note">Retrying will not help until the underlying cause is fixed.</p></Show>
              </>}</Show>
              <small class="mono">{code()}{job().errorDetail ? ` · ${job().errorDetail}` : ''}</small>
            </div>}</Show>
            <Show when={['planned','approved'].includes(job().status)}><button class="ghost danger-ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel queued deployment</button></Show>
          </div>}</Show>
        </Show>
      </article>

      <article class="panel"><span class="eyebrow">AUDIT</span><h2>Recent platform changes</h2><div class="audit-list"><For each={audit.data?.items ?? []}>{item => <div class="audit-row"><div><strong>{item.action}</strong><small>{item.actor} · {new Date(item.createdAt).toLocaleString()}</small></div><code>{item.targetKind}</code></div>}</For></div></article>
    </>
  }}</Show></section>
}
