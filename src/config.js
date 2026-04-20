import 'dotenv/config';
import { normalizeXHandle } from './normalization.js';

function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function getNumber(name, fallback, { min = undefined } = {}) {
  const raw = getEnv(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  return value;
}

function getOptionalNumber(name, { min = undefined } = {}) {
  const raw = getEnv(name);
  if (raw === undefined) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  return value;
}

function getBoolean(name, fallback) {
  const raw = String(getEnv(name, String(fallback))).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getLogMode() {
  const mode = String(getEnv('LOG_MODE', 'normal')).toLowerCase();
  if (!['normal', 'test'].includes(mode)) {
    throw new Error('LOG_MODE must be "normal" or "test"');
  }
  return mode;
}

export function parseTargetXHandles(rawTargets) {
  const handles = String(rawTargets ?? '')
    .split(',')
    .map((target) => normalizeXHandle(target))
    .filter(Boolean);

  return [...new Set(handles)];
}

function getTargetXHandles() {
  return parseTargetXHandles(getEnv('TARGET_X_HANDLES', getEnv('TARGET_X', '')));
}

const targetXHandles = getTargetXHandles();

if (targetXHandles.length === 0) {
  throw new Error('TARGET_X_HANDLES or TARGET_X is required and must contain at least one handle or x.com/twitter.com URL');
}

export const config = {
  pumpPortalWss: 'wss://pumpportal.fun/api/data',
  tradeLocalUrl: 'https://pumpportal.fun/api/trade-local',
  targetXHandles,
  targetXSet: new Set(targetXHandles),
  logMode: getLogMode(),
  autoBuyEnabled: getBoolean('AUTO_BUY_ENABLED', false),
  dryRun: getBoolean('DRY_RUN', true),
  rpcEndpoint: getEnv('RPC_ENDPOINT', 'https://api.mainnet-beta.solana.com'),
  privateKeyBase58: getEnv('PRIVATE_KEY_BASE58', ''),
  buyAmountSol: getNumber('BUY_AMOUNT_SOL', 0.01, { min: 0 }),
  buySlippagePercent: getNumber('BUY_SLIPPAGE_PERCENT', getNumber('SLIPPAGE_PERCENT', 10, { min: 0 }), { min: 0 }),
  sellSlippagePercent: getNumber('SELL_SLIPPAGE_PERCENT', 10, { min: 0 }),
  priorityFeeSol: getNumber('PRIORITY_FEE_SOL', 0.00005, { min: 0 }),
  computeUnitLimit: getNumber('COMPUTE_UNIT_LIMIT', 140000, { min: 1 }),
  computeUnitPriceMicroLamports: getOptionalNumber('COMPUTE_UNIT_PRICE_MICRO_LAMPORTS', { min: 0 }),
  minBalanceSol: getNumber('MIN_BALANCE_SOL', 0.02, { min: 0 }),
  takeProfitEnabled: getBoolean('TAKE_PROFIT_ENABLED', true),
  takeProfitMultiplier: getNumber('TAKE_PROFIT_MULTIPLIER', 2, { min: 1 }),
  takeProfitPollIntervalMs: getNumber('TAKE_PROFIT_POLL_INTERVAL_MS', 1000, { min: 250 }),
  takeProfitMaxDurationMs: getNumber('TAKE_PROFIT_MAX_DURATION_MS', 900000, { min: 1000 }),
  pumpStateCacheMs: getNumber('PUMP_STATE_CACHE_MS', 30000, { min: 0 }),
  staleEventMs: getNumber('STALE_EVENT_MS', 10000, { min: 0 }),
  metadataTimeoutMs: getNumber('METADATA_TIMEOUT_MS', 2500, { min: 100 }),
  reconnectBaseMs: getNumber('RECONNECT_BASE_MS', 500, { min: 100 }),
  reconnectMaxMs: getNumber('RECONNECT_MAX_MS', 10000, { min: 1000 }),
  wssPingIntervalMs: getNumber('WSS_PING_INTERVAL_MS', 15000, { min: 1000 }),
  wssIdleTimeoutMs: getNumber('WSS_IDLE_TIMEOUT_MS', 45000, { min: 5000 })
};
