'use client';

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function Header() {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-[#1e1e1e] bg-[#0a0a0a] sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-[#9945FF] flex items-center justify-center">
            <span className="text-white text-xs font-bold">P</span>
          </div>
          <span className="text-white font-semibold text-lg tracking-tight">PrivateCredit</span>
        </div>
        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-widest text-[#14F195] border border-[#14F195]/30 bg-[#14F195]/5">
          DEVNET
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden sm:flex items-center gap-1.5 text-xs text-gray-500">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14F195] animate-pulse" />
          <span>Arcium MPC</span>
        </div>
        <WalletMultiButton />
      </div>
    </header>
  );
}
