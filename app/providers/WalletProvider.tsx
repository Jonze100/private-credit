'use client';

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { useMemo, useEffect } from 'react';
import { RPC_ENDPOINT } from '../lib/constants';

export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  // Suppress the MetaMask/Zerion fight over window.ethereum — these extensions
  // race to Object.defineProperty(window, 'ethereum', ...) and the loser throws
  // a TypeError that otherwise lands in the React error boundary.
  useEffect(() => {
    const suppress = (e: ErrorEvent) => {
      if (e.message?.includes('Cannot redefine property: ethereum')) {
        e.preventDefault();
        return false;
      }
    };
    window.addEventListener('error', suppress);
    return () => window.removeEventListener('error', suppress);
  }, []);

  // Empty array: WalletProvider ≥ 0.15.28 auto-detects wallets that implement
  // the Wallet Standard (Phantom, Backpack, …). Passing PhantomWalletAdapter
  // explicitly triggers Phantom's "use Standard Wallet Adapters" warning.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
