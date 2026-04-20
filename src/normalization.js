const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const RESERVED_PATHS = new Set(['home', 'intent', 'i', 'share', 'search', 'hashtag', 'explore']);

export function normalizeXHandle(input) {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('@')) {
    return cleanHandle(trimmed.slice(1));
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (!X_HOSTS.has(url.hostname)) {
      return cleanHandle(trimmed);
    }

    const [firstSegment] = url.pathname.split('/').filter(Boolean);
    if (!firstSegment || RESERVED_PATHS.has(firstSegment)) {
      return null;
    }

    return cleanHandle(firstSegment);
  } catch {
    return cleanHandle(trimmed);
  }
}

function cleanHandle(handle) {
  const cleaned = handle
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();

  return /^[a-z0-9_]{1,15}$/.test(cleaned) ? cleaned : null;
}
