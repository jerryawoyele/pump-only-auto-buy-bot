import WebSocket from 'ws';
import { PumpBuyer } from './buyer.js';
import { config } from './config.js';
import { parsePumpPortalMessage, isMigratedOrCompleted, isStaleEvent } from './events.js';
import { extractXHandleFromMetadata, fetchMetadata } from './metadata.js';

const processedMints = new Set();
const buyer = new PumpBuyer(config);

let reconnectAttempt = 0;
let reconnectTimer = null;
let currentWs = null;
let heartbeatTimer = null;
let lastSocketActivityMs = 0;
let shuttingDown = false;

function start() {
  if (shuttingDown) {
    return;
  }

  const ws = new WebSocket(config.pumpPortalWss);
  currentWs = ws;
  lastSocketActivityMs = Date.now();

  ws.on('open', () => {
    reconnectAttempt = 0;
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    startHeartbeat(ws);
    console.info(`connected to PumpPortal; watching for X handles "${config.targetXHandles.join(', ')}"`);
  });

  ws.on('message', (data) => {
    lastSocketActivityMs = Date.now();
    handleMessage(data).catch((error) => {
      console.error(`message handling failed: ${error.message}`);
    });
  });

  ws.on('pong', () => {
    lastSocketActivityMs = Date.now();
  });

  ws.on('error', (error) => {
    console.error(`websocket error: ${error.message}`);
  });

  ws.on('close', (code, reason) => {
    stopHeartbeat();
    if (currentWs === ws) {
      currentWs = null;
    }
    console.warn(`websocket closed (${code}) ${reason ? String(reason) : ''}`.trim());
    scheduleReconnect();
  });
}

async function handleMessage(raw) {
  const parsed = parsePumpPortalMessage(raw);

  if (parsed.kind === 'ignore') {
    return;
  }

  if (parsed.kind === 'reject') {
    logReject(parsed.reason, parsed.mint);
    return;
  }

  const { event } = parsed;

  if (processedMints.has(event.mint)) {
    logReject('already_processed', event.mint);
    return;
  }
  processedMints.add(event.mint);

  if (isStaleEvent(event, config.staleEventMs)) {
    logReject('stale_event', event.mint);
    return;
  }

  if (isMigratedOrCompleted(event)) {
    logReject('already_migrated_or_completed', event.mint);
    return;
  }

  let metadata;
  try {
    metadata = await fetchMetadata(event.uri, config.metadataTimeoutMs);
  } catch (error) {
    logReject(`metadata_fetch_failed:${error.message}`, event.mint);
    return;
  }

  const metadataX = extractXHandleFromMetadata(metadata);
  if (!metadataX) {
    logReject('missing_metadata_x', event.mint);
    return;
  }

  if (!config.targetXSet.has(metadataX)) {
    logReject(`x_mismatch:${metadataX}`, event.mint);
    return;
  }

  console.info(`matched ${event.mint} (${event.symbol ?? 'unknown symbol'}) with X handle "${metadataX}"`);
  await buyer.buy(event);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  const delay = Math.min(config.reconnectBaseMs * 2 ** reconnectAttempt, config.reconnectMaxMs);
  reconnectAttempt += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start();
  }, delay);

  console.warn(`reconnecting in ${delay}ms`);
}

function startHeartbeat(ws) {
  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const idleMs = Date.now() - lastSocketActivityMs;
    if (idleMs > config.wssIdleTimeoutMs) {
      console.warn(`websocket idle for ${idleMs}ms; terminating to force reconnect`);
      ws.terminate();
      return;
    }

    ws.ping();
  }, config.wssPingIntervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function logReject(reason, mint = 'unknown') {
  if (config.logMode !== 'test') {
    return;
  }

  console.info(`reject ${mint}: ${reason}`);
}

function shutdown(signal) {
  console.info(`received ${signal}; shutting down`);
  shuttingDown = true;
  stopHeartbeat();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (currentWs) {
    currentWs.close(1000, signal);
  }

  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
