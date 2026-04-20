import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  OnlinePumpSdk
} from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';

export class PumpBuyer {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.connection = new Connection(config.rpcEndpoint, 'processed');
    this.sdk = new OnlinePumpSdk(this.connection);
    this.keypair = null;
    this.pumpState = null;
    this.pumpStateFetchedAt = 0;
    this.activeTakeProfits = new Map();
    this.activeFlatExits = new Map();
  }

  async buy(event) {
    if (!this.config.autoBuyEnabled || this.config.dryRun) {
      this.logger.info(`[dry-run] matched ${event.mint}; buy skipped`);
      return { dryRun: true };
    }

    const keypair = this.getKeypair();
    await this.assertCanBuy(keypair);

    const mint = new PublicKey(event.mint);
    const user = keypair.publicKey;
    const tokenProgram = await this.getTokenProgram(mint);
    const { global, feeConfig } = await this.getPumpState();
    const buyState = await this.sdk.fetchBuyState(mint, user, tokenProgram);
    const solAmount = solToLamportsBn(this.config.buyAmountSol);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: solAmount
    });

    if (amount.isZero()) {
      throw new Error(`quoted token amount is zero for ${event.mint}`);
    }

    const instructions = await this.sdk.buyInstructions({
      global,
      ...buyState,
      mint,
      user,
      amount,
      solAmount,
      slippage: this.config.buySlippagePercent,
      tokenProgram
    });

    const signature = await this.sendInstructions(instructions, keypair);

    this.logger.info(`bought ${event.mint}: https://solscan.io/tx/${signature}`);

    const position = {
      mint,
      mintString: event.mint,
      tokenProgram,
      amount,
      buySolLamports: solAmount,
      buySignature: signature,
      openedAt: Date.now()
    };

    if (this.config.takeProfitEnabled) {
      this.startTakeProfitMonitor(position);
    }

    if (this.config.flatExitEnabled) {
      this.startFlatExitMonitor(position);
    }

    return { signature, tokenAmount: amount.toString() };
  }

  getKeypair() {
    if (this.keypair) {
      return this.keypair;
    }

    if (!this.config.privateKeyBase58) {
      throw new Error('PRIVATE_KEY_BASE58 is required when DRY_RUN=false');
    }

    this.keypair = Keypair.fromSecretKey(bs58.decode(this.config.privateKeyBase58));
    return this.keypair;
  }

  async assertCanBuy(keypair) {
    if (!this.config.buyAmountSol || this.config.buyAmountSol <= 0) {
      throw new Error('BUY_AMOUNT_SOL must be greater than zero');
    }

    const lamports = await this.connection.getBalance(keypair.publicKey, 'processed');
    const balanceSol = lamports / LAMPORTS_PER_SOL;
    const required = this.config.buyAmountSol + this.config.priorityFeeSol + this.config.minBalanceSol;

    if (balanceSol < required) {
      throw new Error(`insufficient SOL: balance ${balanceSol}, required at least ${required}`);
    }
  }

  async getPumpState() {
    const now = Date.now();
    if (this.pumpState && now - this.pumpStateFetchedAt <= this.config.pumpStateCacheMs) {
      return this.pumpState;
    }

    const [global, feeConfig] = await Promise.all([
      this.sdk.fetchGlobal(),
      this.sdk.fetchFeeConfig().catch((error) => {
        this.logger.warn(`fee config fetch failed; SDK quote will use null fee config: ${error.message}`);
        return null;
      })
    ]);

    this.pumpState = { global, feeConfig };
    this.pumpStateFetchedAt = now;
    return this.pumpState;
  }

  async getTokenProgram(mint) {
    const accountInfo = await this.connection.getAccountInfo(mint, 'processed');
    if (!accountInfo) {
      throw new Error(`mint account not found: ${mint.toBase58()}`);
    }

    if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }

    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return TOKEN_PROGRAM_ID;
    }

    throw new Error(`unsupported token program for ${mint.toBase58()}: ${accountInfo.owner.toBase58()}`);
  }

  async sendInstructions(instructions, keypair) {
    const latestBlockhash = await this.connection.getLatestBlockhash('processed');
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.getComputeUnitPriceMicroLamports() }),
          ...instructions
        ]
      }).compileToV0Message()
    );

    tx.sign([keypair]);

    return await this.connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 0
    });
  }

  getComputeUnitPriceMicroLamports() {
    if (this.config.computeUnitPriceMicroLamports !== null) {
      return Math.floor(this.config.computeUnitPriceMicroLamports);
    }

    const priorityLamports = this.config.priorityFeeSol * LAMPORTS_PER_SOL;
    return Math.floor((priorityLamports * 1_000_000) / this.config.computeUnitLimit);
  }

  startTakeProfitMonitor(position) {
    if (this.activeTakeProfits.has(position.mintString)) {
      return;
    }

    const timer = setInterval(() => {
      this.checkTakeProfit(position).catch((error) => {
        this.logger.warn(`take-profit check failed for ${position.mintString}: ${error.message}`);
      });
    }, this.config.takeProfitPollIntervalMs);

    this.activeTakeProfits.set(position.mintString, timer);
    this.logger.info(`take-profit armed for ${position.mintString} at ${this.config.takeProfitMultiplier}x`);
  }

  startFlatExitMonitor(position) {
    if (this.activeFlatExits.has(position.mintString)) {
      return;
    }

    const timer = setTimeout(() => {
      this.activeFlatExits.delete(position.mintString);
      this.checkFlatExit(position).catch((error) => {
        this.logger.warn(`flat-exit check failed for ${position.mintString}: ${error.message}`);
      });
    }, this.config.flatExitDelayMs);

    this.activeFlatExits.set(position.mintString, timer);
    this.logger.info(`flat-exit armed for ${position.mintString} after ${this.config.flatExitDelayMs}ms`);
  }

  async checkTakeProfit(position) {
    if (Date.now() - position.openedAt > this.config.takeProfitMaxDurationMs) {
      this.stopTakeProfitMonitor(position.mintString, 'max duration reached');
      return;
    }

    const tokenBalance = await this.getTokenBalance(position);
    if (tokenBalance.isZero()) {
      return;
    }

    const sellAmount = BN.min(tokenBalance, position.amount);
    const { global, feeConfig } = await this.getPumpState();
    const sellState = await this.sdk.fetchSellState(position.mint, this.getKeypair().publicKey, position.tokenProgram);
    const quotedSol = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount: sellAmount
    });

    const targetSol = position.buySolLamports.muln(Math.floor(this.config.takeProfitMultiplier * 10000)).divn(10000);
    if (quotedSol.lt(targetSol)) {
      return;
    }

    this.stopTakeProfitMonitor(position.mintString, 'target reached');
    await this.sellPosition(position, sellAmount);
  }

  async checkFlatExit(position) {
    const tokenBalance = await this.getTokenBalance(position);
    if (tokenBalance.isZero()) {
      this.stopTakeProfitMonitor(position.mintString, 'position balance is zero');
      return;
    }

    const sellAmount = tokenBalance;
    const quotedSol = await this.getSellQuote(position, sellAmount);
    const maxHoldSol = position.buySolLamports
      .muln(Math.floor((100 + this.config.flatExitMaxGainPercent) * 10000))
      .divn(100 * 10000);

    if (quotedSol.lt(position.buySolLamports)) {
      this.logger.info(`flat-exit skipped for ${position.mintString}: quote is below entry`);
      return;
    }

    if (quotedSol.gt(maxHoldSol)) {
      this.logger.info(`flat-exit skipped for ${position.mintString}: quote moved above threshold`);
      return;
    }

    this.stopTakeProfitMonitor(position.mintString, 'flat-exit selling full position');
    await this.sellPosition(position, sellAmount);
  }

  async sellPosition(position, amount) {
    const keypair = this.getKeypair();
    const { global, feeConfig } = await this.getPumpState();
    const sellState = await this.sdk.fetchSellState(position.mint, keypair.publicKey, position.tokenProgram);
    const quotedSol = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount
    });

    const instructions = await this.sdk.sellInstructions({
      global,
      ...sellState,
      mint: position.mint,
      user: keypair.publicKey,
      amount,
      solAmount: quotedSol,
      slippage: this.config.sellSlippagePercent,
      tokenProgram: position.tokenProgram,
      mayhemMode: sellState.bondingCurve.isMayhemMode
    });

    const signature = await this.sendInstructions(instructions, keypair);
    this.logger.info(`take-profit sold ${position.mintString}: https://solscan.io/tx/${signature}`);
  }

  async getSellQuote(position, amount) {
    const { global, feeConfig } = await this.getPumpState();
    const sellState = await this.sdk.fetchSellState(position.mint, this.getKeypair().publicKey, position.tokenProgram);

    return getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount
    });
  }

  stopTakeProfitMonitor(mintString, reason) {
    const timer = this.activeTakeProfits.get(mintString);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.activeTakeProfits.delete(mintString);
    this.logger.info(`take-profit stopped for ${mintString}: ${reason}`);
  }

  async getTokenBalance(position) {
    const ata = getAssociatedTokenAddressSync(
      position.mint,
      this.getKeypair().publicKey,
      true,
      position.tokenProgram
    );

    try {
      const balance = await this.connection.getTokenAccountBalance(ata, 'processed');
      return new BN(balance.value.amount);
    } catch {
      return new BN(0);
    }
  }
}

function solToLamportsBn(sol) {
  return new BN(Math.floor(sol * LAMPORTS_PER_SOL).toString());
}
