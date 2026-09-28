import { net, session } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind
} from '../../shared/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { getCommandCodeAuthPath, readCommandCodeCredentials } from './command-code-auth'

const CREDITS_URL = 'https://api.commandcode.ai/alpha/billing/credits'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function windowFrom(value: unknown, windowMinutes: number): RateLimitWindow | null {
  const data = record(value)
  const used = data?.used
  const cap = data?.cap
  if (
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof cap !== 'number' ||
    !Number.isFinite(cap) ||
    cap <= 0
  ) {
    return null
  }
  const reset = data?.resetAt
  return {
    usedPercent: Math.min(100, (used / cap) * 100),
    windowMinutes,
    resetsAt: typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset : null,
    resetDescription: null
  }
}

function failure(
  error: string,
  failureKind: UsageRateLimitFailureKind,
  identity?: string
): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status:
      failureKind === 'missing-credentials' || failureKind === 'usage-unavailable'
        ? 'unavailable'
        : 'error',
    usageMetadata: { source: 'web', failureKind, authProvenance: identity }
  }
}

/** Fetches the same rolling windows as Command Code's /usage command. */
export async function fetchCommandCodeRateLimits(
  options: { authPath?: string; signal?: AbortSignal } = {}
): Promise<ProviderRateLimits> {
  const authPath = options.authPath ?? getCommandCodeAuthPath()
  const credentials = await readCommandCodeCredentials(authPath)
  if (!credentials) {
    return failure('Run command-code login on this host to connect usage.', 'missing-credentials')
  }
  const { apiKey, identity } = credentials
  let response: Response
  try {
    await ensureElectronProxyFromEnvironment({
      proxySession: session.defaultSession,
      probeUrl: CREDITS_URL
    })
    const timeout = AbortSignal.timeout(15_000)
    response = await net.fetch(CREDITS_URL, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    })
  } catch {
    return failure('Could not reach Command Code usage.', 'network', identity)
  }
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    if (response.status === 401 || response.status === 403) {
      return failure(
        'Command Code authentication failed. Run command-code login on this host.',
        'stale-token',
        identity
      )
    }
    return failure(
      `Command Code usage request failed (${response.status}).`,
      response.status === 429 ? 'rate-limited' : 'server',
      identity
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return failure('Could not parse Command Code usage.', 'parse', identity)
  }
  // A login change during the request must not publish the previous account's quota.
  if ((await readCommandCodeCredentials(authPath))?.identity !== identity) {
    return failure('Command Code login changed. Refresh usage.', 'missing-credentials')
  }
  const windows = record(record(payload)?.windowLimits)
  if (!windows) {
    return failure('Command Code usage response has no rolling windows.', 'parse', identity)
  }
  const sessionWindow = windowFrom(windows.fiveHour, 300)
  const weekly = windowFrom(windows.weekly, 10080)
  if ((windows.fiveHour != null && !sessionWindow) || (windows.weekly != null && !weekly)) {
    return failure('Command Code usage response contains invalid windows.', 'parse', identity)
  }
  if (!sessionWindow && !weekly) {
    return failure(
      'No rolling quota is available for this Command Code account.',
      'usage-unavailable',
      identity
    )
  }
  return {
    provider: 'command-code',
    session: sessionWindow,
    weekly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'web',
      credentialSource: 'Command Code CLI login on this host',
      authProvenance: identity
    }
  }
}
