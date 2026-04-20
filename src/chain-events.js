import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { bondingCurvePda, bondingCurveV2Pda, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import bs58 from 'bs58';

const CREATE_LOG_PATTERN = /Instruction:\s*Create(?:V2)?\b/i;
const CREATE_DISCRIMINATOR = anchorDiscriminator('create');
const CREATE_V2_DISCRIMINATOR = anchorDiscriminator('create_v2');

export class PumpCreateTransactionParser {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.connection = new Connection(config.rpcEndpoint, 'confirmed');
  }

  hasCreateLog(logs = []) {
    return logs.some((log) => CREATE_LOG_PATTERN.test(String(log)));
  }

  async parseSignature(signature, expectedSlot = null) {
    const tx = await this.fetchParsedTransaction(signature);
    if (!tx?.meta || tx.meta.err) {
      return { kind: 'ignore', reason: 'failed_or_missing_transaction', signature };
    }

    const logs = tx.meta.logMessages ?? [];
    if (!this.hasCreateLog(logs)) {
      return { kind: 'ignore', reason: 'not_create_log', signature };
    }

    const event = this.extractCreateEvent(tx, signature, expectedSlot);
    if (!event) {
      return { kind: 'reject', reason: 'create_instruction_decode_failed', signature };
    }

    if (!event.mint.endsWith('pump')) {
      return { kind: 'reject', reason: 'mint_not_pump_suffix', mint: event.mint, signature };
    }

    if (!event.uri) {
      return { kind: 'reject', reason: 'missing_uri', mint: event.mint, signature };
    }

    return { kind: 'event', event };
  }

  async fetchParsedTransaction(signature) {
    let lastError = null;

    for (let attempt = 0; attempt < this.config.transactionFetchRetries; attempt += 1) {
      try {
        const tx = await this.connection.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        if (tx) {
          return tx;
        }
      } catch (error) {
        lastError = error;
      }

      await sleep(this.config.transactionFetchRetryMs);
    }

    if (lastError) {
      this.logger.warn(`getParsedTransaction failed for ${signature}: ${lastError.message}`);
    }

    return null;
  }

  extractCreateEvent(tx, signature, expectedSlot) {
    const instructions = tx.transaction.message.instructions ?? [];

    for (const instruction of instructions) {
      const programId = stringifyPubkey(instruction.programId);
      if (programId !== PUMP_PROGRAM_ID.toBase58() || !instruction.data) {
        continue;
      }

      const args = decodeCreateInstructionData(instruction.data);
      if (!args) {
        continue;
      }

      const accounts = (instruction.accounts ?? []).map(String);
      const mint = accounts[0] ?? null;
      const user = accounts[1] ?? null;
      if (!mint) {
        continue;
      }

      return {
        raw: { signature, slot: tx.slot, accounts },
        source: 'solana_logs',
        signature,
        slot: tx.slot ?? expectedSlot,
        mint,
        uri: normalizeMetadataUri(args.uri),
        name: args.name,
        symbol: args.symbol,
        bondingCurve: getBondingCurve(mint, args.version),
        associatedBondingCurve: null,
        creator: args.creator ?? user,
        timestampMs: typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : Date.now()
      };
    }

    return null;
  }
}

export function parseLogsNotification(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return { kind: 'ignore', reason: 'malformed_json' };
  }

  if (message.id && message.result !== undefined) {
    return { kind: 'ack', subscriptionId: message.result };
  }

  const value = message.params?.result?.value;
  if (message.method !== 'logsNotification' || !value?.signature) {
    return { kind: 'ignore', reason: 'not_logs_notification' };
  }

  if (value.err) {
    return { kind: 'ignore', reason: 'failed_transaction', signature: value.signature };
  }

  return {
    kind: 'logs',
    signature: value.signature,
    slot: message.params?.result?.context?.slot ?? null,
    logs: value.logs ?? []
  };
}

export function buildLogsSubscribeMessage(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'logsSubscribe',
    params: [
      { mentions: [PUMP_PROGRAM_ID.toBase58()] },
      { commitment: 'processed' }
    ]
  };
}

export function normalizeMetadataUri(uri) {
  if (typeof uri !== 'string') {
    return null;
  }

  const trimmed = uri.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${trimmed.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  }

  return trimmed;
}

function decodeCreateInstructionData(encoded) {
  let buffer;
  try {
    buffer = Buffer.from(bs58.decode(encoded));
  } catch {
    return null;
  }

  const discriminator = buffer.subarray(0, 8);
  const isCreate = discriminator.equals(CREATE_DISCRIMINATOR);
  const isCreateV2 = discriminator.equals(CREATE_V2_DISCRIMINATOR);
  if (!isCreate && !isCreateV2) {
    return null;
  }

  let offset = 8;
  const name = readBorshString(buffer, offset);
  if (!name) {
    return null;
  }
  offset = name.nextOffset;

  const symbol = readBorshString(buffer, offset);
  if (!symbol) {
    return null;
  }
  offset = symbol.nextOffset;

  const uri = readBorshString(buffer, offset);
  if (!uri) {
    return null;
  }
  offset = uri.nextOffset;

  if (offset + 32 > buffer.length) {
    return null;
  }

  const creator = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();

  return {
    version: isCreateV2 ? 'create_v2' : 'create',
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
    creator
  };
}

function readBorshString(buffer, offset) {
  if (offset + 4 > buffer.length) {
    return null;
  }

  const length = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buffer.length) {
    return null;
  }

  return {
    value: buffer.subarray(start, end).toString('utf8'),
    nextOffset: end
  };
}

function getBondingCurve(mint, version) {
  try {
    const pda = version === 'create_v2' ? bondingCurveV2Pda(mint) : bondingCurvePda(mint);
    return pda.toBase58();
  } catch {
    return null;
  }
}

function anchorDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function stringifyPubkey(pubkey) {
  return typeof pubkey === 'string' ? pubkey : pubkey?.toBase58?.() ?? String(pubkey);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
