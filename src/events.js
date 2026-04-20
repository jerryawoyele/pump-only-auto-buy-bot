const CREATE_TYPES = new Set(['create', 'create_coin', 'created', 'new_token']);
const IPFS_IO_URI_PATTERN = /^https:\/\/ipfs\.io\/ipfs\/[^/?#]+(?:[/?#].*)?$/i;

export function parsePumpPortalMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { kind: 'ignore', reason: 'malformed_json' };
  }

  if (isAck(parsed)) {
    return { kind: 'ignore', reason: 'subscription_ack' };
  }

  const event = parsed.result && typeof parsed.result === 'object' ? parsed.result : parsed;
  if (!isCreateEvent(event, parsed)) {
    return { kind: 'ignore', reason: 'not_new_token_event' };
  }

  const mint = getString(event.mint);
  const uri = getString(event.uri);

  if (!mint) {
    return { kind: 'reject', reason: 'missing_mint' };
  }

  if (!mint.endsWith('pump')) {
    return { kind: 'reject', reason: 'mint_not_pump_suffix', mint };
  }

  if (!uri) {
    return { kind: 'reject', reason: 'missing_uri', mint };
  }

  if (!IPFS_IO_URI_PATTERN.test(uri)) {
    return { kind: 'reject', reason: 'uri_not_ipfs_io', mint };
  }

  return {
    kind: 'event',
    event: {
      raw: event,
      mint,
      uri,
      name: getString(event.name),
      symbol: getString(event.symbol),
      bondingCurve: getString(event.bondingCurve ?? event.bondingCurveKey),
      associatedBondingCurve: getString(event.associatedBondingCurve),
      creator: getString(event.user ?? event.creator ?? event.traderPublicKey ?? event.creator_wallet?.address),
      timestampMs: extractTimestampMs(event)
    }
  };
}

export function isMigratedOrCompleted(event) {
  const raw = event.raw ?? event;
  return Boolean(
    raw.migrated ||
      raw.isMigrated ||
      raw.complete ||
      raw.completed ||
      raw.migration ||
      raw.event_type === 'migrate' ||
      raw.txType === 'migrate' ||
      raw.pool === 'raydium' ||
      raw.pool === 'pump-amm'
  );
}

export function isStaleEvent(event, maxAgeMs, nowMs = Date.now()) {
  if (!maxAgeMs || !event.timestampMs) {
    return false;
  }

  return nowMs - event.timestampMs > maxAgeMs;
}

function isAck(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const text = [message.message, message.status, message.type, message.method]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    text.includes('subscribed') ||
    text.includes('subscription') ||
    message.success === true ||
    message.subscription_id !== undefined && !message.result
  );
}

function isCreateEvent(event, envelope) {
  const eventType = String(event.event_type ?? event.txType ?? event.type ?? '').toLowerCase();
  const method = String(envelope.method ?? '').toLowerCase();

  if (CREATE_TYPES.has(eventType)) {
    return true;
  }

  if (method.includes('create') || method.includes('newtoken')) {
    return true;
  }

  return Boolean(event.mint && event.uri && (event.name || event.symbol || event.bondingCurve || event.bondingCurveKey));
}

function getString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractTimestampMs(event) {
  const raw = event.timestamp ?? event.createdAt ?? event.created_at ?? event.time;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}
