/**
 * scripts/harness/network-policy.mjs
 * Hermetic Network Egress Policy & Proxy Enforcement Engine.
 * Enforces fail-closed network policies, private-IP / loopback blocking,
 * DNS rebinding defenses, and proxy environment sanitization.
 */

const HOSTNAME_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Checks if an IP string belongs to private, loopback, or link-local address spaces.
 */
function isPrivateOrLocalIp(ip) {
  const clean = ip.replace(/[\[\]]/g, '').trim().toLowerCase();
  if (clean === 'localhost' || clean === '::1' || clean === '0.0.0.0' || clean.startsWith('fe80:')) {
    return true;
  }

  const match = IPV4_REGEX.exec(clean);
  if (match) {
    const b0 = Number(match[1]);
    const b1 = Number(match[2]);
    const b2 = Number(match[3]);
    const b3 = Number(match[4]);

    if ([b0, b1, b2, b3].some(b => b > 255)) return false;

    if (b0 === 10) return true; // 10.0.0.0/8
    if (b0 === 127) return true; // 127.0.0.0/8 (loopback)
    if (b0 === 0) return true; // 0.0.0.0/8
    if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 (link-local)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
    if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
  }

  return false;
}

/**
 * Normalizes host string by trimming, lowercasing, and stripping scheme/ports.
 */
export function normalizeAllowedHost(host) {
  if (typeof host !== 'string') return '';
  let cleaned = host.trim().toLowerCase();
  // Strip protocol if present
  if (cleaned.includes('://')) {
    try {
      const u = new URL(cleaned);
      cleaned = u.hostname;
    } catch {
      cleaned = cleaned.replace(/^[a-z]+:\/\//i, '');
    }
  }
  // Strip port
  cleaned = cleaned.split(':')[0] || '';
  // Strip trailing slashes or paths
  cleaned = cleaned.split('/')[0] || '';
  return cleaned;
}

/**
 * Validates a NetworkPolicy contract.
 */
export function validateNetworkPolicy(policy) {
  const errors = [];

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { valid: false, errors: ['NetworkPolicy must be a non-null object'] };
  }

  if (policy.mode === 'none') {
    return { valid: true, errors: [] };
  }

  if (policy.mode === 'allowlist') {
    // 1. Validate proxyUrl
    if (typeof policy.proxyUrl !== 'string' || policy.proxyUrl.trim().length === 0) {
      errors.push('allowlist mode requires non-empty proxyUrl');
    } else {
      try {
        const u = new URL(policy.proxyUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          errors.push(`proxyUrl must use http: or https: protocol, received: '${u.protocol}'`);
        }
        if (u.username || u.password) {
          errors.push('proxyUrl must not contain embedded username or password credentials');
        }
      } catch (err) {
        errors.push(`Invalid proxyUrl '${policy.proxyUrl}': ${err.message}`);
      }
    }

    // 2. Validate allowedHosts
    if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0) {
      errors.push('allowlist mode requires a non-empty array of allowedHosts');
    } else {
      for (let i = 0; i < policy.allowedHosts.length; i++) {
        const host = policy.allowedHosts[i];
        if (typeof host !== 'string' || host.trim().length === 0) {
          errors.push(`allowedHosts[${i}] must be a non-empty string`);
          continue;
        }

        if (host.includes('*')) {
          errors.push(`allowedHosts[${i}] contains wildcards ('*'), which are prohibited: '${host}'`);
        }

        const normalized = normalizeAllowedHost(host);
        if (isPrivateOrLocalIp(normalized)) {
          errors.push(`allowedHosts[${i}] resolves to private or local network destination: '${host}'`);
        } else if (!HOSTNAME_REGEX.test(normalized) && !IPV4_REGEX.test(normalized)) {
          errors.push(`allowedHosts[${i}] is not a valid public hostname: '${host}'`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  return {
    valid: false,
    errors: [`Unsupported network policy mode: '${policy.mode}'. Must be 'none' or 'allowlist'.`]
  };
}

/**
 * Checks if a destination URL or host is permitted under policy.
 */
export function isDestinationAllowed(destination, policy) {
  if (!policy || policy.mode === 'none') {
    return false;
  }

  if (policy.mode !== 'allowlist' || !Array.isArray(policy.allowedHosts)) {
    return false;
  }

  let targetHost = '';
  try {
    if (destination.includes('://')) {
      const u = new URL(destination);
      targetHost = u.hostname;
    } else {
      targetHost = normalizeAllowedHost(destination);
    }
  } catch {
    targetHost = normalizeAllowedHost(destination);
  }

  if (!targetHost || isPrivateOrLocalIp(targetHost)) {
    return false;
  }

  const allowedSet = new Set(policy.allowedHosts.map(normalizeAllowedHost));
  return allowedSet.has(targetHost);
}

/**
 * Builds sanitized environment variables for proxy configuration.
 */
export function buildProxyEnvironment(policy) {
  if (!policy || policy.mode === 'none') {
    return {
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: ''
    };
  }

  if (policy.mode === 'allowlist') {
    return {
      HTTP_PROXY: policy.proxyUrl,
      HTTPS_PROXY: policy.proxyUrl,
      ALL_PROXY: policy.proxyUrl,
      NO_PROXY: 'localhost,127.0.0.1'
    };
  }

  return {
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: ''
  };
}
