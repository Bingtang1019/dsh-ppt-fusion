import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { DshPptFailure } from '../engine/errors.ts'

/**
 * URL policy for `dsh-ppt source` (plan §3.7): a URL handed to the engine must be
 * public http(s), and the guard fails closed.
 *
 * The engine's own `web-to-md` already refuses private hosts unless
 * `--allow-private-hosts` is passed; the fusion never passes it, and this pre-flight
 * check names the refusal before a process starts. Byte-size and MIME limits are
 * enforced after conversion (the engine writes Markdown text, not raw responses).
 */

/** Default maximum URL length; longer URLs are treated as an abuse signal. */
export const URL_MAX_LENGTH = 2048

/** Ports a source URL may use unless the caller widens the set. */
export const URL_ALLOWED_PORTS: readonly number[] = [80, 443]

/** Implied hosts that never leave the machine, refused before any DNS lookup. */
const LOCAL_HOSTNAMES = ['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata.google.internal']

/**
 * @param address - IPv4 dotted quad.
 * @returns the address as a 32-bit integer, or null when it is not IPv4.
 */
function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/**
 * @param address - IPv4 address.
 * @returns true for loopback, private, link-local, CGNAT, multicast, reserved and
 *   unspecified ranges.
 */
export function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address)
  if (value === null) return true
  const inRange = (start: string, end: string): boolean => {
    const low = ipv4ToInt(start) ?? 0
    const high = ipv4ToInt(end) ?? 0
    return value >= low && value <= high
  }
  return (
    inRange('0.0.0.0', '0.255.255.255') ||
    inRange('10.0.0.0', '10.255.255.255') ||
    inRange('100.64.0.0', '100.127.255.255') ||
    inRange('127.0.0.0', '127.255.255.255') ||
    inRange('169.254.0.0', '169.254.255.255') ||
    inRange('172.16.0.0', '172.31.255.255') ||
    inRange('192.0.0.0', '192.0.0.255') ||
    inRange('192.0.2.0', '192.0.2.255') ||
    inRange('192.168.0.0', '192.168.255.255') ||
    inRange('198.18.0.0', '198.19.255.255') ||
    inRange('198.51.100.0', '198.51.100.255') ||
    inRange('203.0.113.0', '203.0.113.255') ||
    inRange('224.0.0.0', '239.255.255.255') ||
    inRange('240.0.0.0', '255.255.255.255')
  )
}

/**
 * @param address - IPv6 address in any common spelling.
 * @returns true for loopback, unique-local, link-local, multicast, unspecified and
 *   IPv4-mapped addresses that map onto a blocked IPv4 range.
 */
export function isBlockedIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? ''
  if (value === '::' || value === '::1') return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (/^fe[89ab]/.test(value)) return true
  if (value.startsWith('ff')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1]
  if (mapped !== undefined) return isBlockedIpv4(mapped)
  return false
}

/** @param address - an IP literal. @returns true when the policy refuses it. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true
}

/** Options for `assertPublicHttpUrl`. */
export interface UrlPolicyOptions {
  /** DNS resolver seam; production uses `node:dns/promises`. */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>
  readonly allowedPorts?: readonly number[]
}

/** A URL that passed the policy, with the addresses it resolved to. */
export interface AllowedUrl {
  readonly url: URL
  readonly addresses: readonly string[]
}

/**
 * Prove a URL is public http(s) (plan §3.7).
 *
 * @param raw - the URL as typed by the caller.
 * @param options - resolver seam and port allowance.
 * @returns the parsed URL and every address it resolves to.
 * @throws DshPptFailure `UsageError` for a scheme, credential, port, length or address
 *   the policy refuses; the message names the rule.
 */
export async function assertPublicHttpUrl(raw: string, options: UrlPolicyOptions = {}): Promise<AllowedUrl> {
  if (raw.length > URL_MAX_LENGTH) {
    throw new DshPptFailure('UsageError', `source URL is longer than ${String(URL_MAX_LENGTH)} characters`, { detail: { url: raw.slice(0, 64) } })
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DshPptFailure('UsageError', `source input is not a URL: ${raw}`, { detail: { input: raw } })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DshPptFailure('UsageError', `source URL must be http or https, received ${url.protocol}`, { detail: { url: raw } })
  }
  if (url.username !== '' || url.password !== '') {
    throw new DshPptFailure('UsageError', 'source URL must not carry credentials', { detail: { url: `${url.protocol}//…@${url.host}` } })
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === '') {
    throw new DshPptFailure('UsageError', 'source URL has no host', { detail: { url: raw } })
  }
  if (LOCAL_HOSTNAMES.includes(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new DshPptFailure('UsageError', `source URL host ${hostname} is a local name, which this policy refuses`, { detail: { hostname } })
  }
  const allowedPorts = options.allowedPorts ?? URL_ALLOWED_PORTS
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (!allowedPorts.includes(port)) {
    throw new DshPptFailure('UsageError', `source URL port ${String(port)} is not allowed (${allowedPorts.join(', ')})`, { detail: { port } })
  }
  const resolveHost = options.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address))
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new DshPptFailure('UsageError', `source URL host ${hostname} is not a public address`, { detail: { hostname } })
    }
    return { url, addresses: [hostname] }
  }
  let addresses: readonly string[]
  try {
    addresses = await resolveHost(hostname)
  } catch (error) {
    throw new DshPptFailure('UsageError', `source URL host ${hostname} did not resolve: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { hostname },
      cause: error,
    })
  }
  if (addresses.length === 0) {
    throw new DshPptFailure('UsageError', `source URL host ${hostname} resolved to no address`, { detail: { hostname } })
  }
  const blocked = addresses.filter((address) => isBlockedAddress(address))
  if (blocked.length > 0) {
    throw new DshPptFailure('UsageError', `source URL host ${hostname} resolves to a non-public address (${blocked.join(', ')})`, { detail: { hostname, addresses } })
  }
  return { url, addresses }
}
