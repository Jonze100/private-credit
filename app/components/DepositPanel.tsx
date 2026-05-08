'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import * as anchor from '@coral-xyz/anchor';
import { makeProvider, makeProgram, getMxeKey, txDeposit } from '../lib/program';
import { setupCipher, encryptDeposit } from '../lib/crypto';
import { TxEvent } from '../lib/types';

interface DepositPanelProps {
  onTx: (e: TxEvent) => void;
  onDeposited: (amount: number, price: number) => void;
}

export function DepositPanel({ onTx, onDeposited }: DepositPanelProps) {
  const wallet = useWallet();
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'sending' | 'waiting'>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = status !== 'idle';

  async function handleDeposit() {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return;
    const amtNum = parseFloat(amount);
    const priceNum = parseFloat(price);
    if (!amtNum || !priceNum) { setError('Enter valid amount and price'); return; }

    setError(null);
    try {
      setStatus('encrypting');
      const provider = makeProvider(wallet as unknown as anchor.Wallet);
      const program = makeProgram(provider);
      const mxeKey = await getMxeKey(provider);
      const { publicKey, cipher } = await setupCipher(mxeKey);
      const { ciphertexts, nonce } = await encryptDeposit(cipher, BigInt(Math.round(amtNum * 1e6)), BigInt(Math.round(priceNum * 1e6)));

      setStatus('sending');
      const sig = await txDeposit(program, wallet as unknown as anchor.Wallet, publicKey, ciphertexts, nonce);

      setStatus('waiting');
      onDeposited(amtNum, priceNum);
      onTx({
        id: sig,
        type: 'deposit',
        label: 'Deposit',
        detail: `${amtNum} SOL @ $${priceNum}`,
        signature: sig,
        timestamp: Date.now(),
        ok: true,
      });
      setAmount('');
      setPrice('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      onTx({
        id: Date.now().toString(),
        type: 'deposit',
        label: 'Deposit',
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
    encrypting: 'Encrypting with RescueCipher...',
    sending: 'Sending to Solana...',
    waiting: 'Awaiting MPC finalization...',
  }[status];

  return (
    <div className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Deposit Collateral</h2>
        <span className="text-[10px] font-mono text-[#9945FF] border border-[#9945FF]/30 px-2 py-0.5 rounded">
          PRIVATE
        </span>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-gray-500">Amount (SOL)</label>
        <input
          type="number"
          min="0"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          className="w-full bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-[#9945FF]/50 disabled:opacity-50"
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs text-gray-500">Collateral Price (USD)</label>
        <input
          type="number"
          min="0"
          placeholder="0.00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={busy}
          className="w-full bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-[#9945FF]/50 disabled:opacity-50"
        />
      </div>

      {statusText && (
        <div className="flex items-center gap-2 text-xs text-[#14F195]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14F195] animate-pulse" />
          {statusText}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleDeposit}
        disabled={busy || !wallet.connected}
        className="w-full bg-[#9945FF] hover:bg-[#7d35d6] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
      >
        {busy ? 'Processing...' : wallet.connected ? 'Deposit' : 'Connect Wallet'}
      </button>
    </div>
  );
}
