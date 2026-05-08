'use client';

import { useState, useEffect } from 'react';
import { Header } from '../components/Header';
import { MetricCard } from '../components/MetricCard';
import { DepositPanel } from '../components/DepositPanel';
import { BorrowPanel } from '../components/BorrowPanel';
import { HealthPanel } from '../components/HealthPanel';
import { InterestPanel } from '../components/InterestPanel';
import { TxHistory } from '../components/TxHistory';
import { TxEvent } from '../lib/types';

export default function Home() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [collateralAmount, setCollateralAmount] = useState(0);
  const [collateralPrice, setCollateralPrice] = useState(0);
  const [borrowAmount, setBorrowAmount] = useState(0);
  const [interestAccrued, setInterestAccrued] = useState(0);
  const [healthFactor, setHealthFactor] = useState<number | null>(null);
  const [isLiquidatable, setIsLiquidatable] = useState<boolean | null>(null);
  const [txEvents, setTxEvents] = useState<TxEvent[]>([]);

  function addTx(e: TxEvent) {
    setTxEvents((prev) => [...prev, e]);
  }

  const collateralValue = collateralAmount * collateralPrice;

  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <span className="text-gray-600 text-sm">Loading...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Header />

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard
            label="Collateral"
            value={collateralAmount > 0 ? `${collateralAmount.toFixed(4)} SOL` : '—'}
            sub={collateralValue > 0 ? `$${collateralValue.toFixed(2)}` : undefined}
            accent="purple"
          />
          <MetricCard
            label="Total Borrowed"
            value={borrowAmount > 0 ? `$${borrowAmount.toFixed(2)}` : '—'}
            accent="green"
          />
          <MetricCard
            label="Health Factor"
            value={healthFactor !== null ? healthFactor.toFixed(2) : '—'}
            sub={healthFactor !== null ? (healthFactor >= 1 ? 'Healthy' : 'At risk') : undefined}
            accent={healthFactor !== null ? (healthFactor >= 1.5 ? 'green' : 'white') : 'white'}
          />
          <MetricCard
            label="Interest Accrued"
            value={interestAccrued > 0 ? `$${interestAccrued.toFixed(4)}` : '—'}
          />
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left column */}
          <div className="space-y-6">
            <DepositPanel
              onTx={addTx}
              onDeposited={(amt, price) => {
                setCollateralAmount(amt);
                setCollateralPrice(price);
              }}
            />
            <BorrowPanel
              collateralAmount={collateralAmount}
              collateralPrice={collateralPrice}
              currentBorrow={borrowAmount}
              onTx={addTx}
              onBorrowed={(amt) => setBorrowAmount((prev) => prev + amt)}
            />
          </div>

          {/* Right column */}
          <div className="space-y-6">
            <HealthPanel
              collateralAmount={collateralAmount}
              collateralPrice={collateralPrice}
              borrowAmount={borrowAmount + interestAccrued}
              healthFactor={healthFactor}
              onTx={addTx}
              onHealth={setHealthFactor}
            />
            <InterestPanel
              collateralAmount={collateralAmount}
              collateralPrice={collateralPrice}
              borrowAmount={borrowAmount}
              isLiquidatable={isLiquidatable}
              onTx={addTx}
              onInterestAccrued={(inc) => setInterestAccrued((prev) => prev + inc)}
              onLiquidatable={setIsLiquidatable}
            />
          </div>
        </div>

        {/* TX History */}
        <TxHistory events={txEvents} />
      </main>
    </div>
  );
}
