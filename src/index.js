import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { PumpBuyer } from './buyer.js';
import {
  buildLogsSubscribeMessage,
  parseLogsNotification,
  PumpCreateTransactionParser
} from './chain-events.js';
import { config } from './config.js';
import { isMigratedOrCompleted, isStaleEvent } from './events.js';
import { extractXHandleFromMetadata, fetchMetadata } from './metadata.js';
import { ListenerState } from './state.js';

const processedMints = new Set();
const processedSignatures = new Set();
const buyer = new PumpBuyer(config);
const parser = new PumpCreateTransactionParser(config);
const listenerState = new ListenerState(config.listenerStatePath);
const pumpProgramPublicKey = new PublicKey(PUMP_PROGRAM_ID);

let reconnectAttempt = 0;
let reconnectTimer = null;
let currentWs = null;
let heartbeatTimer = null;
let lastSocketActivityMs = 0;
let shuttingDown = false;
let messageQueue = Promise.resolve();
let cursorBlockedSignature = null;
let stateWriteFailed = false;

await listenerState.load();
start();

function start() {
  if (shuttingDown) {
    return;
  }

  const cursorAtConnect = listenerState.cursor.lastSignature;
  const ws = new WebSocket(config.rpcWssEndpoint);
  currentWs = ws;
  lastSocketActivityMs = Date.now();

  ws.on('open', () => {
    reconnectAttempt = 0;
    ws.send(JSON.stringify(buildLogsSubscribeMessage()));
    startHeartbeat(ws);
    console.info(`connected to Solana logsSubscribe; watching Pump.fun creates for X handles "${config.targetXHandles.join(', ')}"`);

    if (config.backfillEnabled && cursorAtConnect) {
      enqueue(() => backfill(cursorAtConnect));
    }
  });

  ws.on('message', (data) => {
    lastSocketActivityMs = Date.now();
    enqueue(() => handleMessage(data));
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
  const parsed = parseLogsNotification(raw);

  if (parsed.kind === 'ack') {
    console.info(`logsSubscribe active with subscription id ${parsed.subscriptionId}`);
    return;
  }

  if (parsed.kind === 'ignore') {
    return;
  }

  if (!parser.hasCreateLog(parsed.logs)) {
    await advanceCursor(parsed.signature, parsed.slot);
    return;
  }

  await processSignature(parsed.signature, parsed.slot);
}

async function processSignature(signature, slot = null) {
  if (cursorBlockedSignature && cursorBlockedSignature !== signature) {
    return;
  }

  if (processedSignatures.has(signature)) {
    return;
  }
  processedSignatures.add(signature);

  const parsed = await parser.parseSignature(signature, slot);

  if (parsed.reason === 'failed_or_missing_transaction') {
    processedSignatures.delete(signature);
    cursorBlockedSignature = signature;
    console.warn(`transaction ${signature} was not fetchable yet; reconnecting so backfill can retry without advancing the cursor`);
    currentWs?.terminate();
    return;
  }

  if (parsed.kind === 'ignore') {
    await advanceCursor(signature, slot);
    return;
  }

  if (parsed.kind === 'reject') {
    logReject(parsed.reason, parsed.mint ?? signature);
    await advanceCursor(signature, slot);
    return;
  }

  const { event } = parsed;
  if (cursorBlockedSignature === signature) {
    cursorBlockedSignature = null;
  }

  if (processedMints.has(event.mint)) {
    logReject('already_processed', event.mint);
    await advanceCursor(signature, event.slot ?? slot);
    return;
  }
  processedMints.add(event.mint);

  if (isStaleEvent(event, config.staleEventMs)) {
    logReject('stale_event', event.mint);
    await advanceCursor(signature, event.slot ?? slot);
    return;
  }

  if (isMigratedOrCompleted(event)) {
    logReject('already_migrated_or_completed', event.mint);
    await advanceCursor(signature, event.slot ?? slot);
    return;
  }

  let metadata;
  try {
    metadata = await fetchMetadata(event.uri, config.metadataTimeoutMs);
  } catch (error) {
    logReject(`metadata_fetch_failed:${error.message}`, event.mint);
    await advanceCursor(signature, event.slot ?? slot);
    return;
  }

  const metadataX = extractXHandleFromMetadata(metadata);
  if (!metadataX) {
    logReject('missing_metadata_x', event.mint);
    await advanceCursor(signature, event.slot ?? slot);
    return;
  }

  if (!config.targetXSet.has(metadataX)) {
    logReject(`x_mismatch:${metadataX}`, event.mint);
    await advanceCursor(signature, event.slot ?? slot);
    return;
  }

  console.info(`matched ${event.mint} (${event.symbol ?? 'unknown symbol'}) with X handle "${metadataX}" from ${signature}`);
  await buyer.buy(event);
  await advanceCursor(signature, event.slot ?? slot);
}

async function backfill(untilSignature) {
  console.info(`backfilling Pump.fun signatures since ${untilSignature}`);

  let before = undefined;
  let fetched = 0;
  let reachedCursor = false;

  while (!shuttingDown && fetched < config.backfillMaxSignatures) {
    const limit = Math.min(1000, config.backfillMaxSignatures - fetched);
    const signatures = await parser.connection.getSignaturesForAddress(
      pumpProgramPublicKey,
      { until: untilSignature, before, limit },
      'confirmed'
    );

    if (signatures.length === 0) {
      break;
    }

    fetched += signatures.length;
    reachedCursor ||= signatures.some((entry) => entry.signature === untilSignature);

    for (const entry of [...signatures].reverse()) {
      if (entry.signature === untilSignature || entry.err) {
        continue;
      }

      await processSignature(entry.signature, entry.slot);
    }

    if (signatures.length < limit || reachedCursor) {
      break;
    }

    before = signatures[signatures.length - 1].signature;
  }

  if (!reachedCursor && fetched >= config.backfillMaxSignatures) {
    console.warn(`backfill hit BACKFILL_MAX_SIGNATURES=${config.backfillMaxSignatures}; increase it if downtime was long`);
  }
}

function enqueue(task) {
  messageQueue = messageQueue
    .then(task)
    .catch((error) => {
      console.error(`queued task failed: ${error.message}`);
    });
}

async function advanceCursor(signature, slot = null) {
  try {
    await listenerState.saveCursor(signature, slot);
  } catch (error) {
    if (!stateWriteFailed) {
      stateWriteFailed = true;
      console.warn(`listener state persistence disabled: ${error.message}`);
    }
  }
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
