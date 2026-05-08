import type { Metadata } from 'next';
import './globals.css';
import { SolanaWalletProvider } from '../providers/WalletProvider';

export const metadata: Metadata = {
  title: 'PrivateCredit',
  description: 'Confidential lending on Solana via Arcium MPC',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SolanaWalletProvider>{children}</SolanaWalletProvider>
      </body>
    </html>
  );
}
