import { Show, createSignal } from 'solid-js'
import type { Component, JSX } from 'solid-js'
import { api } from '../lib/api'
import { authState } from '../lib/auth'

export const LoginGate: Component<{ children: JSX.Element }> = (props) => {
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')

  const submit: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent> = async (event) => {
    event.preventDefault()
    if (busy()) return
    const user = username().trim()
    if (!user || !password()) return
    setBusy(true)
    setError('')
    try {
      await api.authenticate(user, password())
      setPassword('')
    } catch {
      setError('Nie udało się zalogować. Sprawdź użytkownika i hasło.')
    } finally {
      setBusy(false)
    }
  }

  return <Show when={authState.authenticated()} fallback={
    <main class="login-shell">
      <section class="login-card" aria-labelledby="control-plane-login-title">
        <div class="login-brand"><span class="brand-mark">CR</span><div><strong>CrowdRelay</strong><small>Control Plane</small></div></div>
        <span class="eyebrow">OPERATOR ACCESS</span>
        <h1 id="control-plane-login-title">Zaloguj się do Control Plane</h1>
        <p>Panel operatorski dla tenantów, wdrożeń i stanu ekosystemu.</p>
        <form class="login-form" onSubmit={submit}>
          <label>Użytkownik<input name="username" autocomplete="username" value={username()} onInput={e => setUsername(e.currentTarget.value)} required autofocus /></label>
          <label>Hasło<input name="password" type="password" autocomplete="current-password" value={password()} onInput={e => setPassword(e.currentTarget.value)} required /></label>
          <Show when={error()}><div class="login-error" role="alert">{error()}</div></Show>
          <button type="submit" disabled={busy() || !username().trim() || !password()}>{busy() ? 'Logowanie…' : 'Zaloguj się'}</button>
        </form>
        <div class="login-security"><span class="auth-dot ok"/><span>Dane logowania zostają w tej karcie i nie trafiają do trwałego magazynu przeglądarki. Odświeżenie nie wylogowuje; zamknięcie karty tak.</span></div>
      </section>
    </main>
  }>{props.children}</Show>
}
