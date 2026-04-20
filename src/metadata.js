import { normalizeXHandle } from './normalization.js';

const X_URL_PATTERN = /(?:^|\/\/)(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\//i;
const TRUSTED_X_KEYS = new Set([
  'x',
  'xhandle',
  'xlink',
  'xurl',
  'twitter',
  'twitterhandle',
  'twitterlink',
  'twitterurl'
]);

export async function fetchMetadata(uri, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(uri, {
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/plain;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`metadata fetch returned HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function extractXHandleFromMetadata(metadata) {
  const explicitTwitter = findFirstTrustedXValue(metadata, 'twitter');
  if (explicitTwitter !== undefined) {
    return normalizeXHandle(explicitTwitter);
  }

  const handles = [];

  collectStringValues(metadata, [], (value, path) => {
    const hasXUrl = X_URL_PATTERN.test(value);
    const hasTrustedKey = hasTrustedXKey(path);

    if (!hasXUrl && !hasTrustedKey) {
      return;
    }

    const handle = normalizeXHandle(value);
    if (!handle) {
      return;
    }

    handles.push(handle);
  });

  return handles[0] ?? null;
}

function findFirstTrustedXValue(value, keyName, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstTrustedXValue(item, keyName, seen);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedKey === keyName && typeof item === 'string') {
      return item;
    }

    const found = findFirstTrustedXValue(item, keyName, seen);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function hasTrustedXKey(path) {
  return path.some((segment) => {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, '');
    return TRUSTED_X_KEYS.has(normalized);
  });
}

function collectStringValues(value, path, onString, seen = new Set()) {
  if (typeof value === 'string') {
    onString(value, path);
    return;
  }

  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringValues(item, [...path, String(index)], onString, seen));
    return;
  }

  Object.entries(value).forEach(([key, item]) => {
    collectStringValues(item, [...path, key], onString, seen);
  });
}
