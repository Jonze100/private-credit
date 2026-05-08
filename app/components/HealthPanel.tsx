'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import * as anchor from '@coral-xyz/anchor';
import { makeProvider, makeProgram, getMxeKey, txComputeHealthFactor } from '../lib/program';
import { setupCipher, encryptHealth, decryptHealthFactor } from '../lib/crypto';
import { TxEvent } from '../lib/types';

interface HealthPanelProps {
  collateralAmount: number;
  collateralPrice: number;
  borrowAmount: number;
  healthFactor: number | null;
  onTx: (e: TxEvent) => void;
  onHealth: (hf: number) => void;
}

export function HealthPanel({ collateralAmount, collateralPrice, borrowAmount, healthFactor, onTx, onHealth }: HealthPanelProps) {
  const wallet = useWallet();
  const [price, setPrice] = useState('');
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'sending' | 'decrypting'>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = status !== 'idle';

  const hfColor =
    healthFactor === null ? 'text-gray-500'
    : healthFactor >= 1.5 ? 'text-[#14F195]'
    : healthFactor >= 1.0 ? 'text-yellow-400'
    : 'text-red-400';

  const barPct = healthFactor === null ? 0 : Math.min(100, (healthFactor / 2) * 100);
  const barColor =
    healthFactor === null ? 'bg-gray-700'
    : healthFactor >= 1.5 ? 'bg-[#14F195]'
    : healthFactor >= 1.0 ? 'bg-yellow-400'
    : 'bg-red-500';

  async function handleCheck() {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return;
    const priceNum = parseFloat(price) || collateralPrice;
    if (!priceNum) { setError('Enter current price'); return; }

    setError(null);
    try {
      setStatus('encrypting');
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

      setStatus('sending');
      const result = await txComputeHealthFactor(
        program,
        wallet as unknown as anchor.Wallet,
        publicKey,
        ciphertexts,
        nonce,
        Math.round(priceNum * 1e6),
      );

      setStatus('decrypting');
      const hf = decryptHealthFactor(
        cipher,
        result.encryptedCollateralScaled,
        result.encryptedTotalDebt,
        result.nonce,
      );

      onHealth(hf);
      onTx({
        id: Date.now().toString(),
        type: 'health',
        label: 'Health Check',
        detail: `HF = ${hf.toFixed(2)}`,
        timestamp: Date.now(),
        ok: true,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('idle');
    }
  }

  const statusText = {
    idle: null,
    encrypting: 'Encrypting position...',
    sending: 'MPC computing health factor...',
    decrypting: 'Decrypting result...',
  }[status];

  return (
    <div className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Health Factor</h2>
        <span className="text-[10px] font-mono text-blue-400 border border-blue-400/30 px-2 py-0.5 rounded">
          ENCRYPTED
        </span>
      </div>

      <div className="text-center py-2">
        <p className={`text-5xl font-bold font-mono ${hfColor}`}>
          {healthFactor !== null ? healthFactor.toFixed(2) : '—'}
        </p>
        <p className="text-xs text-gray-600 mt-1">
          {healthFactor === null ? 'Run check to compute' : healthFactor >= 1.0 ? 'Position healthy' : 'At risk of liquidation'}
        </p>
      </div>

      <div className="w-full bg-[#0a0a0a] rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all ${barColor}`}
          style={{ width: `${barPct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-600">
        <span>0</span>
        <span>1.0 (liquidation)</span>
        <span>2.0+</span>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-gray-500">Current Price (USD, optional)</label>
        <input
          type="number"
          min="0"
          placeholder={collateralPrice ? String(collateralPrice) : '0.00'}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={busy}
          className="w-full bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-700 focus:outline-none focus:border-blue-400/50 disabled:opacity-50"
        />
      </div>

      {statusText && (
        <div className="flex items-center gap-2 text-xs text-blue-400">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          {statusText}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleCheck}
        disabled={busy || !wallet.connected}
        className="w-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-blue-400 text-sm font-medium py-2.5 rounded-lg transition-colors"
      >
        {busy ? 'Computing...' : 'Check Health'}
      </button>
    </div>
  );
}
