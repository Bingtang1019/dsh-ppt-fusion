import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, isBlockedAddress, isBlockedIpv4, isBlockedIpv6, URL_MAX_LENGTH } from './url-policy.ts'

const resolveTo = (addresses: readonly string[]) => async (): Promise<readonly string[]> => addresses

describe('isBlockedIpv4', () => {
  it('blocks the private, loopback, link-local, CGNAT and reserved ranges', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '203.0.113.5', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedIpv4(address), address).toBe(true)
    }
  })

  it('allows public ranges', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '192.169.0.1']) {
      expect(isBlockedIpv4(address), address).toBe(false)
    }
  })
})

describe('isBlockedIpv6', () => {
  it('blocks loopback, unique-local, link-local, multicast and mapped private v4', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isBlockedIpv6(address), address).toBe(true)
    }
    expect(isBlockedIpv6('2606:4700:4700::1111')).toBe(false)
  })

  it('classifies literals through isBlockedAddress', () => {
    expect(isBlockedAddress('192.168.0.1')).toBe(true)
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedAddress('not-an-ip')).toBe(true)
  })
})

describe('assertPublicHttpUrl', () => {
  it('accepts a public host and returns its addresses', async () => {
    const allowed = await assertPublicHttpUrl('https://example.com/article', { resolveHost: resolveTo(['93.184.216.34']) })
    expect(allowed.url.hostname).toBe('example.com')
    expect(allowed.addresses).toEqual(['93.184.216.34'])
  })

  it('accepts a public IP literal without a DNS lookup', async () => {
    const allowed = await assertPublicHttpUrl('http://93.184.216.34/a', { resolveHost: resolveTo([]) })
    expect(allowed.addresses).toEqual(['93.184.216.34'])
  })

  it('refuses schemes other than http(s), credentials, ports and over-long URLs', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com/x')).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('https://user:secret@example.com/x')).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('https://example.com:8080/x', { resolveHost: resolveTo(['93.184.216.34']) })).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl(`https://example.com/${'a'.repeat(URL_MAX_LENGTH)}`)).rejects.toMatchObject({ code: 'UsageError' })
  })

  it('refuses local names and hosts that resolve to a non-public address', async () => {
    await expect(assertPublicHttpUrl('http://localhost/x')).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('http://metadata.google.internal/x')).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('http://[::1]/x')).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('https://intranet.example/x', { resolveHost: resolveTo(['10.0.0.5']) })).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('https://mixed.example/x', { resolveHost: resolveTo(['93.184.216.34', '127.0.0.1']) })).rejects.toMatchObject({ code: 'UsageError' })
  })

  it('fails closed when the host does not resolve', async () => {
    await expect(assertPublicHttpUrl('https://nowhere.example/x', { resolveHost: async () => { throw new Error('ENOTFOUND') } })).rejects.toMatchObject({ code: 'UsageError' })
    await expect(assertPublicHttpUrl('https://nowhere.example/x', { resolveHost: resolveTo([]) })).rejects.toMatchObject({ code: 'UsageError' })
  })
})
