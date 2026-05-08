'use client';

import { TxEvent } from '../lib/types';

interface TxHistoryProps {
  events: TxEvent[];
}

const typeLabel: Record<string, string> = {
  deposit: 'Deposit',
  borrow: 'Borrow',
  health: 'Health Check',
  interest: 'Accrue Interest',
  liquidation: 'Liquidation Check',
};

const typeColor: Record<string, string> = {
  deposit: 'text-[#9945FF]',
  borrow: 'text-[#14F195]',
  health: 'text-blue-400',
  interest: 'text-yellow-400',
  liquidation: 'text-red-400',
};

export function TxHistory({ events }: TxHistoryProps) {
  return (
    <div className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-4">
      <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-3">Transaction History</h3>
      {events.length === 0 ? (
        <p className="text-xs text-gray-600 text-center py-6">No transactions yet</p>
      ) : (
        <ul className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {[...events].reverse().map((e) => (
            <li key={e.id} className="flex items-start gap-3 text-xs">
              <span
                className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.ok ? 'bg-[#14F195]' : 'bg-red-500'}`}
              />
              <div className="flex-1 min-w-0">
                <span className={`font-medium ${typeColor[e.type] ?? 'text-gray-300'}`}>
                  {typeLabel[e.type] ?? e.type}
                </span>
                <span className="text-gray-500 ml-1">— {e.detail}</span>
              </div>
              <span className="text-gray-600 flex-shrink-0">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
