'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import * as anchor from '@coral-xyz/anchor';
import { makeProvider, makeProgram, getMxeKey, txBorrow } from '../lib/program';
import { setupCipher, encryptBorrow } from '../lib/crypto';
import { LTV_MAX_PCT } from '../lib/constants';
import { TxEvent } from '../lib/types';

interface BorrowPanelProps {
  collateralAmount: number;
  collateralPrice: number;
  currentBorrow: number;
  onTx: (e: TxEvent) => void;
  onBorrowed: (amount: number) => void;
}

export function BorrowPanel({ collateralAmount, collateralPrice, currentBorrow, onTx, onBorrowed }: BorrowPanelProps) {
  const wallet = useWallet();
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'sending' | 'waiting'>('idle');
  const [approved, setApproved] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = status !== 'idle';
  const maxBorrow = collateralAmount * collateralPrice * (LTV_MAX_PCT / 100);
  const ltvPct = maxBorrow > 0 ? Math.min(100, (currentBorrow / maxBorrow) * 100) : 0;

  async function handleBorrow() {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return;
    const amtNum = parseFloat(amount);
    if (!amtNum) { setError('Enter a valid amount'); return; }

    setError(null);
    setApproved(null);
    try {
      setStatus('encrypting');
      const provider = makeProvider(wallet as unknown as anchor.Wallet);
      const program = makeProgram(provider);
      const mxeKey = await getMxeKey(provider);
      const { publicKey, cipher } = await setupCipher(mxeKey);
      const { ciphertexts, nonce } = await encryptBorrow(
        cipher,
        BigInt(Math.round(collateralAmount * 1e6)),
        BigInt(Math.round(currentBorrow * 1e6)),
      );

      setStatus('sending');
      const result = await txBorrow(
        program,
        wallet as unknown as anchor.Wallet,
        publicKey,
        ciphertexts,
        nonce,
        Math.round(amtNum * 1e6),
        Math.round(collateralPrice * 1e6),
      );

      setApproved(result.approved);
      if (result.approved) {
        onBorrowed(amtNum);
        onTx({
          id: result.sig,
          type: 'borrow',
          label: 'Borrow',
          detail: `$${amtNum} — approved`,
          signature: result.sig,
          timestamp: Date.now(),
          ok: true,
        });
        setAmount('');
      } else {
        onTx({
          id: result.sig,
          type: 'borrow',
          label: 'Borrow',
          detail: `$${amtNum} — rejected (LTV)`,
          timestamp: Date.now(),
          ok: false,
        });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      onTx({
        id: Date.now().toString(),
        type: 'borrow',
        label: 'Borrow',
        detail: 'failed',
        timestamp: Date.now(),
        ok: false,
      });
    } finally {
      setStatus('idle');
    }
  }

  const statusText = {
    idle: null,
    encrypting: 'Encrypting position data...',
    sending: 'MPC computing LTV check...',
    waiting: 'Awaiting MPC finalization...',
  }[status];

  return (
    <div className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Borrow</h2>
        <span className="text-[10px] font-mono text-[#14F195] border border-[#14F195]/30 px-2 py-0.5 rounded">
          MPC LTV CHECK
        </span>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-500">LTV Utilization</span>
          <span className="text-white font-mono">{ltvPct.toFixed(1)}% / {LTV_MAX_PCT}%</span>
        </div>
        <div className="w-full bg-[#0a0a0a] rounded-full h-1.5">
          <div
            className={`h-1.5 rounded-full transition-all ${ltvPct > 90 ? 'bg-red-500' : ltvPct > 70 ? 'bg-yellow-400' : 'bg-[#14F195]'}`}
            style={{ width: `${ltvPct}%` }}
          />
        </div>
        <p className="text-xs text-gray-600 mt-1">Max: ${maxBorrow.toFixed(2)}</p>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-gray-500">Borrow Amount (USD)</label>
        <input
          type="number"
          min="0"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          className="w-full bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-[#14F195]/50 disabled:opacity-50"
        />
      </div>

      {statusText && (
        <div className="flex items-center gap-2 text-xs text-[#14F195]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14F195] animate-pulse" />
          {statusText}
        </div>
      )}

      {approved === true && <p className="text-xs text-[#14F195]">Borrow approved by MPC</p>}
      {approved === false && <p className="text-xs text-red-400">Borrow rejected — LTV exceeded</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleBorrow}
        disabled={busy || !wallet.connected}
        className="w-full bg-[#14F195]/10 hover:bg-[#14F195]/20 border border-[#14F195]/30 disabled:opacity-40 disabled:cursor-not-allowed text-[#14F195] text-sm font-medium py-2.5 rounded-lg transition-colors"
      >
        {busy ? 'MPC computing...' : wallet.connected ? 'Borrow' : 'Connect Wallet'}
      </button>
    </div>
  );
}
