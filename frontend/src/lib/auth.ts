import { createSignal } from 'solid-js'

// A Basic Authorization header is password-equivalent, so it is deliberately
// kept out of any storage that outlives the tab. It is held in memory and
// mirrored into tab-scoped session storage only, which the browser clears when
// the tab closes. That keeps a reload (Ctrl-R) signed in without leaving a
// credential behind for the next person to open this origin.
//
// The residual exposure is a same-origin script reading sessionStorage. The
// panel ships a strict CSP (script-src 'self', no inline script) which is what
// makes that acceptable here; moving the edge to a server-issued HttpOnly
// session would remove it entirely and is the intended end state.
const STORAGE_KEY = 'crowdrelay-control-plane-session'

const readStored = (): string | null => {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY)
    return value && value.startsWith('Basic ') ? value : null
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Falling back
    // to memory-only keeps the panel usable instead of failing to boot.
    return null
  }
}

const [authorization, setAuthorization] = createSignal<string | null>(readStored())

const persist = (value: string | null) => {
  try {
    if (value === null) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, value)
  } catch {
    // Memory-only for this tab; the operator simply signs in again on reload.
  }
}

export const authState = {
  authorization,
  authenticated: () => authorization() !== null,
  setBasic(username: string, password: string) {
    const bytes = new TextEncoder().encode(`${username}:${password}`)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const value = `Basic ${btoa(binary)}`
    setAuthorization(value)
    persist(value)
  },
  clear() {
    setAuthorization(null)
    persist(null)
  },
}
