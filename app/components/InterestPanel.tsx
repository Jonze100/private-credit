'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import * as anchor from '@coral-xyz/anchor';
import { makeProvider, makeProgram, getMxeKey, txAccrueInterest, txCheckLiquidatable } from '../lib/program';
import { setupCipher, encryptInterest, encryptHealth, computeInterestIncrement } from '../lib/crypto';
import { TxEvent } from '../lib/types';

interface InterestPanelProps {
  collateralAmount: number;
  collateralPrice: number;
  borrowAmount: number;
  isLiquidatable: boolean | null;
  onTx: (e: TxEvent) => void;
  onInterestAccrued: (amount: number) => void;
  onLiquidatable: (v: boolean) => void;
}

export function InterestPanel({
  collateralAmount,
  collateralPrice,
  borrowAmount,
  isLiquidatable,
  onTx,
  onInterestAccrued,
  onLiquidatable,
}: InterestPanelProps) {
  const wallet = useWallet();
  const [rateBps, setRateBps] = useState('500');
  const [days, setDays] = useState('30');
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'sending' | 'checking'>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = status !== 'idle';

  const elapsedSecs = parseFloat(days) * 86400 || 0;
  const rateNum = parseFloat(rateBps) || 0;
  const incrementPreview =
    borrowAmount > 0 && rateNum > 0 && elapsedSecs > 0
      ? (borrowAmount * rateNum * elapsedSecs) / 315_360_000_000
      : 0;

  async function handleAccrue() {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return;
    const elapsedSecsInt = Math.round(elapsedSecs);
    if (!elapsedSecsInt || !rateNum) { setError('Enter rate and days'); return; }

    setError(null);
    try {
      setStatus('encrypting');
      const provider = makeProvider(wallet as unknown as anchor.Wallet);
      const program = makeProgram(provider);
      const mxeKey = await getMxeKey(provider);
      const { publicKey, cipher } = await setupCipher(mxeKey);
      const { ciphertexts, nonce } = await encryptInterest(
        cipher,
        BigInt(Math.round(borrowAmount * 1e6)),
        BigInt(Math.round(incrementPreview * 1e6)),
      );

      const increment = computeInterestIncrement(
        BigInt(Math.round(borrowAmount * 1e6)),
        BigInt(rateNum),
        BigInt(elapsedSecsInt),
      );

      setStatus('sending');
      await txAccrueInterest(
        program,
        wallet as unknown as anchor.Wallet,
        publicKey,
        ciphertexts,
        nonce,
        increment,
      );

      onInterestAccrued(incrementPreview);
      onTx({
        id: Date.now().toString(),
        type: 'interest',
        label: 'Accrue Interest',
        detail: `+$${incrementPreview.toFixed(4)} over ${days}d`,
        timestamp: Date.now(),
        ok: true,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('idle');
    }
  }

  async function handleCheckLiquidatable() {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return;

    setError(null);
    try {
      setStatus('checking');
      const provider = makeProvider(wallet as unknown as anchor.Wallet);
      const program = makeProgram(provider);
      const mxeKey = await getMxeKey(provider);
      const { publicKey, cipher } = await setupCipher(mxeKey);
      const { ciphertexts, nonce } = await encryptHealth(
        cipher,
        BigInt(Math.round(collateralAmount * 1e6)),
        BigInt(Math.round(collateralPrice * 1e6)),
        BigInt(Math.round(borrowAmount * 1e6)),
      );

      const result = await txCheckLiquidatable(
        program,
        wallet as unknown as anchor.Wallet,
        publicKey,
        ciphertexts,
        nonce,
        Math.round(collateralPrice * 1e6),
      );

      onLiquidatable(result);
      onTx({
        id: Date.now().toString(),
        type: 'liquidation',
        label: 'Liquidation Check',
        detail: result ? 'LIQUIDATABLE' : 'Safe',
        timestamp: Date.now(),
        ok: !result,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('idle');
    }
  }

  const statusText = {
    idle: null,
    encrypting: 'Encrypting interest data...',
    sending: 'MPC accruing interest...',
    checking: 'MPC checking liquidation...',
  }[status];

  return (
    <div className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Interest & Liquidation</h2>
        {isLiquidatable !== null && (
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              isLiquidatable
                ? 'text-red-400 border-red-400/30'
                : 'text-[#14F195] border-[#14F195]/30'
            }`}
          >
            {isLiquidatable ? 'LIQUIDATABLE' : 'SAFE'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-gray-500">Rate (bps)</label>
          <input
            type="number"
            min="0"
            value={rateBps}
            onChange={(e) => setRateBps(e.target.value)}
            disabled={busy}
            className="w-full bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-yellow-400/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-gray-500">Days</label>
          <input
            type="number"
            min="0"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            disabled={busy}
            className="w-full bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-yellow-400/50 disabled:opacity-50"
          />
        </div>
      </div>

      {incrementPreview > 0 && (
        <p className="text-xs text-gray-500">
          Increment preview:{' '}
          <span className="text-yellow-400 font-mono">${incrementPreview.toFixed(6)}</span>
        </p>
      )}

      {statusText && (
        <div className="flex items-center gap-2 text-xs text-yellow-400">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
          {statusText}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={handleAccrue}
          disabled={busy || !wallet.connected}
          className="flex-1 bg-yellow-400/10 hover:bg-yellow-400/20 border border-yellow-400/30 disabled:opacity-40 disabled:cursor-not-allowed text-yellow-400 text-sm font-medium py-2.5 rounded-lg transition-colors"
        >
          Accrue Interest
        </button>
        <button
          onClick={handleCheckLiquidatable}
          disabled={busy || !wallet.connected}
          className="flex-1 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-red-400 text-sm font-medium py-2.5 rounded-lg transition-colors"
        >
          Check Liquidatable
        </button>
      </div>
    </div>
  );
}
