# Pump-only Auto-buy Bot

This bot listens directly to Solana `logsSubscribe` for the Pump.fun program, filters create transactions to `pump`-ending mints, fetches token metadata, matches the token's X/Twitter handle against `TARGET_X_HANDLES`, and then builds/signs a direct Pump buy transaction locally with the official `@pump-fun/pump-sdk`.

The default config is safe: `AUTO_BUY_ENABLED=false` and `DRY_RUN=true`, so matching tokens are logged but not bought until you explicitly opt in.

`LOG_MODE=normal` keeps logs focused on matched tokens and active trade lifecycle events. `LOG_MODE=test` also logs every reject reason, which is useful while tuning filters.

## Setup

1. Install Node.js 20 or newer.
2. Install dependencies:

```powershell
npm install
```

3. Copy `.env.example` to `.env` and fill in your values.
4. Start in dry-run mode first:

```powershell
npm start
```

## Required `.env`

`TARGET_X_HANDLES` is the comma-separated X/Twitter handle list that metadata can match. Each entry can be `somehandle`, `@somehandle`, `https://x.com/somehandle`, or `https://twitter.com/somehandle`.

Example:

```dotenv
TARGET_X_HANDLES=somehandle,@anotherhandle,https://x.com/thirdhandle
```

For real buys, set all of these:

```dotenv
AUTO_BUY_ENABLED=true
DRY_RUN=false
PRIVATE_KEY_BASE58=your_wallet_private_key
RPC_ENDPOINT=your_rpc_endpoint
RPC_WSS_ENDPOINT=your_rpc_websocket_endpoint
BUY_AMOUNT_SOL=0.01
BUY_SLIPPAGE_PERCENT=10
PRIORITY_FEE_SOL=0.00005
TAKE_PROFIT_ENABLED=true
TAKE_PROFIT_MULTIPLIER=2
FLAT_EXIT_ENABLED=true
FLAT_EXIT_DELAY_MS=30000
FLAT_EXIT_MAX_GAIN_PERCENT=0
```

## Hardcoded Flow

The bot rejects a token if:

- The websocket message is malformed, an ack, a failed transaction, or not a Pump.fun create log.
- The create transaction cannot be fetched or decoded from RPC after retries.
- The `mint` is missing or does not end with `pump`.
- The metadata `uri` is missing.
- The event looks stale beyond `STALE_EVENT_MS`, when that setting is greater than `0`.
- The mint was already processed.
- The token event indicates it has migrated or completed bonding.
- Metadata fetch or JSON parsing fails.
- No X/Twitter link or handle exists in metadata.
- The normalized metadata handle does not equal one of your `TARGET_X_HANDLES`.
- Real buying is enabled but the wallet, amount, RPC, or balance is invalid.

After a real buy lands, the bot arms in-memory exit monitors. With the default `TAKE_PROFIT_MULTIPLIER=2`, it polls the Pump bonding curve and sends a direct Pump sell when the SDK sell quote for the bought token amount is at least 2x the initial buy spend. With `FLAT_EXIT_ENABLED=true`, it also checks once after `FLAT_EXIT_DELAY_MS`; if the full-position sell quote is at entry or slightly above entry within `FLAT_EXIT_MAX_GAIN_PERCENT`, it sells 100% of the remaining token balance. If the quote is below entry, it keeps holding.

## Notes

- Pump.fun program monitored: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Subscription sent: Solana `logsSubscribe` with `{ "mentions": ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] }` and `processed` commitment.
- The bot fetches each create transaction with `getParsedTransaction`, decodes the Pump create instruction, and persists the last processed signature to `LISTENER_STATE_PATH`.
- On reconnect, the bot backfills Pump.fun program signatures with `getSignaturesForAddress` until the last persisted signature, capped by `BACKFILL_MAX_SIGNATURES`.
- Buy/sell transaction builder: official `@pump-fun/pump-sdk` local instruction construction.
- Pool is Pump bonding curve only; there is no Raydium, PumpSwap, PumpPortal `trade-local`, or `auto` routing.
- Coverage-first defaults use `STALE_EVENT_MS=0`, so delayed and backfilled creates are still metadata-checked. Use a positive value only if you prefer speed-only trading over never missing relevant target X metadata.
- Take-profit state is currently in memory. If the worker restarts after buying, it will not resume monitoring that position unless durable position storage is added.

## Fly.io Worker Deployment

This repo includes a worker-only `fly.toml` and `Dockerfile`. The Fly process group is:

```toml
[processes]
  worker = "npm run worker"
```

There is intentionally no `http_service` because the bot is a long-running outbound WebSocket client, not an HTTP app. The default region is `iad` for East US placement.

Before deploying, change the `app` name in `fly.toml` or let `fly launch` generate one. Store sensitive config as Fly secrets, not in the image:

```powershell
fly secrets set TARGET_X_HANDLES=somehandle,anotherhandle
fly secrets set RPC_ENDPOINT=https://your-rpc.example
fly secrets set PRIVATE_KEY_BASE58=your_wallet_private_key
fly secrets set AUTO_BUY_ENABLED=false DRY_RUN=true
```

Deploy the worker:

```powershell
fly deploy
```

Keep exactly one worker Machine running unless you have durable dedupe/buy state. Multiple workers can race the same mint without shared state.
