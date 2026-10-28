// fetch() for links that come from outside: apply links from job sites and links in people's
// emails. Anyone can put a link in an email, so before the server opens one it makes sure the
// link goes to the public internet: http(s) on the normal ports, and a host that resolves only to
// public addresses (checked again when connecting, so a DNS answer that changes in between cannot
// slip through). Redirects are followed by hand, each hop checked the same way. Without this, an
// email could make the server call its own database, the host's admin panels or a cloud metadata
// address (server-side request forgery).

import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
    this.code = 'EBLOCKED';
  }
}

// Addresses that are not the public internet: loopback, private networks, link-local (cloud
// metadata lives at 169.254.169.254), carrier NAT, multicast, reserved and documentation ranges.
const BLOCKED = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED.addSubnet(ip, bits, 'ipv4');
}
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  BLOCKED.addSubnet(ip, bits, 'ipv6');
}

export function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    // IPv4 written as IPv6 (::ffff:127.0.0.1) is judged as the IPv4 address.
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
    if (/^::ffff:/i.test(ip)) return true;
    return BLOCKED.check(ip, 'ipv6');
  }
  return BLOCKED.check(ip, 'ipv4');
}

/** Throws BlockedUrlError unless the URL may be opened by the server. Returns the parsed URL. */
export function checkPublicUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError('Not a valid link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError(`Links must be http or https, not ${u.protocol}`);
  if (u.username || u.password) throw new BlockedUrlError('Links with a user name or password are not opened.');
  if (u.port && !['80', '443'].includes(u.port)) throw new BlockedUrlError(`Port ${u.port} is not opened.`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BlockedUrlError(`${host || 'That host'} is not on the public internet.`);
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError(`${host} is not on the public internet.`);
  return u;
}

// DNS lookup that refuses private addresses; runs on every connection the agent opens.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked) return callback(new BlockedUrlError(`${hostname} points to ${blocked.address}, which is not on the public internet.`));
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const agent = new Agent({ connect: { lookup: publicLookup }, connections: 16 });

const MAX_REDIRECTS = 6;

/**
 * Same as fetch(), for outside links. `redirect: 'follow'` (the default) follows up to six
 * redirects, each checked; 'manual' returns the redirect response as it is.
 */
export async function safeFetch(url, init = {}) {
  const follow = (init.redirect ?? 'follow') === 'follow';
  let current = checkPublicUrl(url).toString();
  for (let hop = 0; ; hop += 1) {
    const res = await undiciFetch(current, { ...init, redirect: 'manual', dispatcher: agent });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!follow || !location) return res;
    res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new BlockedUrlError('Too many redirects.');
    current = checkPublicUrl(new URL(location, current).toString()).toString();
  }
}
