'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {
  Lock, LockOpen, ArrowDownUp, ShieldCheck, Clock,
  RefreshCw, ExternalLink, Copy, CircleAlert, Check, Wallet,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import {
  makeProvider, makeProgram, getMxeKey,
  txDeposit, txBorrow, txComputeHealthFactor, txAccrueInterest, txCreatePosition,
  makeKeypairWallet,
} from '../lib/program';
import { PROGRAM_ID, RPC_ENDPOINT } from '../lib/constants';
import {
  setupCipher, encryptDeposit, encryptBorrow, encryptHealth, encryptInterest,
  decryptHealthFactor, computeInterestIncrement,
} from '../lib/crypto';
import { LTV_MAX_PCT } from '../lib/constants';
import type { TxEvent } from '../lib/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Retries an async tx on transient wallet-conflict errors (e.g. the
// MetaMask/Zerion window.ethereum race can briefly destabilise the injected
// provider; a short delay is enough for Phantom to settle).
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 600): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConflict =
        msg.includes('ethereum') ||
        msg.includes('redefine') ||
        msg.includes('Provider not found') ||
        msg.includes('not found');
      if (i < attempts - 1 && isConflict) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  // unreachable, but satisfies TS
  throw new Error('withRetry exhausted');
}

function makeAnchorWallet(wallet: ReturnType<typeof useWallet>): anchor.Wallet {
  return {
    publicKey: wallet.publicKey!,
    signTransaction: wallet.signTransaction!,
    signAllTransactions: wallet.signAllTransactions!,
  } as anchor.Wallet;
}

function fmtUsd(n: number) {
  const s = n.toFixed(2);
  const [int, dec] = s.split('.');
  return { main: `$${Number(int).toLocaleString('en-US')}`, dim: `.${dec}` };
}

function healthColor(tone: string) {
  return tone === 'good' ? '#14F195' : tone === 'warn' ? '#F5B82E' : '#FF4D5A';
}
function healthLabel(tone: string) {
  return tone === 'good' ? 'Healthy' : tone === 'warn' ? 'At risk' : 'Liquidatable';
}
function healthToneFor(hf: number) {
  return hf > 1.5 ? 'good' : hf >= 1.0 ? 'warn' : 'bad';
}

// ─── usePositionAccount ───────────────────────────────────────────────────────

function getPositionPdaClient(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), owner.toBuffer()],
    new PublicKey(PROGRAM_ID),
  );
  return pda;
}

type PositionStatus = 'loading' | 'exists' | 'missing' | 'disconnected';

function usePositionAccount(): { status: PositionStatus; recheck: () => void } {
  const wallet = useWallet();
  const [status, setStatus] = useState<PositionStatus>('disconnected');

  const check = useCallback(async () => {
    if (!wallet.connected || !wallet.publicKey) { setStatus('disconnected'); return; }
    setStatus('loading');
    try {
      const conn = new Connection(RPC_ENDPOINT, 'confirmed');
      const pda = getPositionPdaClient(wallet.publicKey);
      const info = await conn.getAccountInfo(pda);
      setStatus(info ? 'exists' : 'missing');
    } catch {
      setStatus('missing');
    }
  }, [wallet.connected, wallet.publicKey]);

  useEffect(() => { check(); }, [check]);

  return { status, recheck: check };
}

// ─── Icon ─────────────────────────────────────────────────────────────────────

type LucideComp = React.ComponentType<LucideProps>;
const ICONS: Record<string, LucideComp> = {
  'lock': Lock, 'lock-open': LockOpen, 'arrow-down-up': ArrowDownUp,
  'shield-check': ShieldCheck, 'clock': Clock, 'refresh-cw': RefreshCw,
  'external-link': ExternalLink, 'copy': Copy, 'circle-alert': CircleAlert,
  'check': Check, 'wallet': Wallet,
};

function Icon({ name, size = 16, stroke = 1.5, style, className }: {
  name: string; size?: number; stroke?: number;
  style?: React.CSSProperties; className?: string;
}) {
  const L = ICONS[name];
  if (!L) return null;
  return <L size={size} strokeWidth={stroke} style={style} className={className} />;
}

// ─── Button ───────────────────────────────────────────────────────────────────

function Btn({
  variant = 'primary', size, block, icon, iconRight, disabled, children, onClick, className = '', style,
}: {
  variant?: string; size?: string; block?: boolean; icon?: string; iconRight?: string;
  disabled?: boolean; children?: React.ReactNode; onClick?: () => void;
  className?: string; style?: React.CSSProperties;
}) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', block ? 'btn-block' : '', className]
    .filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled} onClick={onClick} style={style}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} stroke={1.8} />}
      {children && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} stroke={1.8} />}
    </button>
  );
}

// ─── Pill ─────────────────────────────────────────────────────────────────────

function Pill({ tone = 'neutral', icon, dot = true, children }: {
  tone?: string; icon?: string; dot?: boolean; children?: React.ReactNode;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon ? <Icon name={icon} size={11} stroke={2} /> : dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

// ─── Cipher ───────────────────────────────────────────────────────────────────

function Cipher({ width = 6, decrypted = null, className = '' }: {
  width?: number; decrypted?: string | null; className?: string;
}) {
  if (decrypted !== null) return <span className={`tnum ${className}`}>{decrypted}</span>;
  return <span className={`cipher ${className}`}>{'•'.repeat(width)}</span>;
}

// ─── EncryptingButton ─────────────────────────────────────────────────────────

function EncryptingButton({ label, icon = 'lock', disabled, variant = 'primary', block = true, onAction }: {
  label: string; icon?: string; disabled?: boolean;
  variant?: string; block?: boolean; onAction?: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<'idle' | 'encrypting' | 'mpc' | 'done' | 'error'>('idle');

  const start = async () => {
    if (phase !== 'idle' || !onAction) return;
    setPhase('encrypting');
    const mpcTimer = setTimeout(() => setPhase('mpc'), 700);
    try {
      await onAction();
      clearTimeout(mpcTimer);
      setPhase('mpc');
      await new Promise((r) => setTimeout(r, 300));
      setPhase('done');
      setTimeout(() => setPhase('idle'), 1400);
    } catch {
      clearTimeout(mpcTimer);
      setPhase('error');
      setTimeout(() => setPhase('idle'), 2000);
    }
  };

  const labels: Record<string, string> = {
    idle: label, encrypting: 'Encrypting…', mpc: 'Awaiting MPC…', done: 'Done', error: 'Failed',
  };
  const icons: Record<string, string> = {
    idle: icon, encrypting: icon, mpc: icon, done: 'check', error: 'circle-alert',
  };

  return (
    <Btn
      variant={variant}
      block={block}
      icon={icons[phase]}
      disabled={disabled || phase !== 'idle'}
      onClick={start}
      className={phase === 'mpc' ? 'mpc-pending' : ''}
    >
      <span className={phase === 'encrypting' || phase === 'mpc' ? 'shimmer' : ''}>
        {labels[phase]}
      </span>
    </Btn>
  );
}

// ─── ConnectButton ────────────────────────────────────────────────────────────

function ConnectButton() {
  const { connected, connecting, publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const addr = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`
    : null;

  if (connected) {
    return (
      <button className="btn btn-secondary btn-sm" onClick={disconnect}>
        <Icon name="wallet" size={13} stroke={1.8} />
        <span>{addr}</span>
      </button>
    );
  }
  return (
    <button className="btn btn-secondary btn-sm" onClick={() => setVisible(true)}>
      <Icon name="wallet" size={13} stroke={1.8} />
      <span>{connecting ? 'Connecting…' : 'Connect wallet'}</span>
    </button>
  );
}

// ─── TopNav ───────────────────────────────────────────────────────────────────

const LOGO = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%20width%3D%2232%22%20height%3D%2232%22%20fill%3D%22none%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%226%22%20fill%3D%22%230a0a0a%22%2F%3E%3Crect%20x%3D%220.5%22%20y%3D%220.5%22%20width%3D%2231%22%20height%3D%2231%22%20rx%3D%225.5%22%20stroke%3D%22%239945FF%22%20stroke-opacity%3D%220.5%22%2F%3E%3Cpath%20d%3D%22M11%2014.5V12.5C11%209.74%2013.24%207.5%2016%207.5C18.76%207.5%2021%209.74%2021%2012.5V14.5%22%20stroke%3D%22%23F5F5F5%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%2F%3E%3Crect%20x%3D%229.5%22%20y%3D%2214.5%22%20width%3D%2213%22%20height%3D%2210%22%20rx%3D%222%22%20fill%3D%22%239945FF%22%2F%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2219.5%22%20r%3D%221.4%22%20fill%3D%22%230a0a0a%22%2F%3E%3Crect%20x%3D%2215.4%22%20y%3D%2219.5%22%20width%3D%221.2%22%20height%3D%222.8%22%20rx%3D%220.6%22%20fill%3D%22%230a0a0a%22%2F%3E%3C%2Fsvg%3E";

function TopNav() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <div className="nav-left">
          <a className="nav-brand" href="#">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO} width={28} height={28} alt="" />
            <span className="word">PrivateCredit</span>
          </a>
        </div>
        <div className="nav-right">
          <span className="nav-net">
            <span className="dot" />
            Solana · devnet
          </span>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

// ─── LtvBar ───────────────────────────────────────────────────────────────────

function LtvBar({ ltv = 0, cap = LTV_MAX_PCT }: { ltv?: number; cap?: number }) {
  const overCap = ltv > cap;
  const approaching = !overCap && ltv > cap * 0.9;
  const fill = Math.min(100, (ltv / 100) * 100);
  const color = overCap ? 'var(--danger)' : approaching ? 'var(--warn)' : 'var(--accent)';
  const valColor = overCap ? 'var(--danger)' : approaching ? 'var(--warn)' : 'var(--fg)';
  return (
    <div className="ltv">
      <div className="ltv-head">
        <span>LTV</span>
        <span className="v">
          <span style={{ color: valColor }}>{ltv.toFixed(1)}%</span>
          <span className="dim"> / {cap}%</span>
        </span>
      </div>
      <div className="ltv-bar">
        <div className="fill" style={{ width: `${fill}%`, background: color }} />
        <div className="threshold" style={{ left: `${cap}%` }} />
      </div>
    </div>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, valueDim, delta, deltaTone, icon, encrypted }: {
  label: string; value?: React.ReactNode; valueDim?: string;
  delta?: React.ReactNode; deltaTone?: string; icon?: string; encrypted?: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="lbl">
        {icon && <Icon name={icon} size={11} stroke={1.8} />}
        {label}
      </div>
      <div className="v">
        {encrypted
          ? <Cipher width={6} />
          : <>{value}{valueDim && <span className="dim">{valueDim}</span>}</>}
      </div>
      <div className={`delta${deltaTone === 'pos' ? ' pos' : deltaTone === 'neg' ? ' neg' : ''}`}>
        {delta}
      </div>
    </div>
  );
}

// ─── MetricRow ────────────────────────────────────────────────────────────────

function MetricRow({ collateral, borrowed, ltv, health, healthTone, interest, encrypted }: {
  collateral: number; borrowed: number; ltv: number;
  health: number; healthTone: string; interest: number; encrypted: boolean;
}) {
  const c = fmtUsd(collateral);
  const b = fmtUsd(borrowed);
  const i = fmtUsd(interest);
  return (
    <div className="row-4">
      <MetricCard
        label="Total collateral" value={c.main} valueDim={c.dim}
        delta="Encrypted on-chain" icon="lock" encrypted={encrypted}
      />
      <MetricCard
        label="Borrowed" value={b.main} valueDim={b.dim}
        delta={`${ltv.toFixed(1)}% LTV / ${LTV_MAX_PCT}%`} icon="arrow-down-up" encrypted={encrypted}
      />
      <MetricCard
        label="Health factor"
        value={<span style={{ color: healthColor(healthTone) }}>{health.toFixed(2)}</span>}
        delta={<span style={{ color: healthColor(healthTone) }}>{healthLabel(healthTone)}</span>}
        icon="shield-check"
      />
      <MetricCard
        label="Interest accrued" value={i.main} valueDim={i.dim}
        delta="5.0% APR" icon="clock" encrypted={encrypted}
      />
    </div>
  );
}

// ─── HFStop ───────────────────────────────────────────────────────────────────

function HFStop({ tone, range, active }: { tone: string; range: string; active: boolean }) {
  const c = tone === 'good' ? '#14F195' : tone === 'warn' ? '#F5B82E' : '#FF4D5A';
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      border: `1px solid ${active ? c : 'rgba(255,255,255,0.07)'}`,
      background: active ? `color-mix(in oklab, ${c} 10%, transparent)` : 'transparent',
      transition: 'border-color var(--dur) var(--ease), background var(--dur) var(--ease)',
    }}>
      <div className="lbl" style={{ color: active ? c : 'var(--fg-dim)', fontSize: 10 }}>
        {tone === 'good' ? 'Healthy' : tone === 'warn' ? 'At risk' : 'Liquidatable'}
      </div>
      <div className="tnum" style={{ fontSize: 13, color: active ? c : 'var(--fg-muted)', marginTop: 2 }}>
        {range}
      </div>
    </div>
  );
}

// ─── DevWalletButton ──────────────────────────────────────────────────────────

function DevWalletButton({ onKeypair }: { onKeypair: (kp: Keypair) => void }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [addr, setAddr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setStatus('loading');
    setErr(null);
    try {
      const res = await fetch('/api/dev-keypair');
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const { bytes, error } = await res.json();
      if (error) throw new Error(error);
      const kp = Keypair.fromSecretKey(Uint8Array.from(bytes));
      setAddr(kp.publicKey.toBase58());
      setStatus('done');
      onKeypair(kp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  };

  if (status === 'done' && addr) {
    return (
      <div style={{
        padding: '8px 12px', borderRadius: 8, fontSize: 12,
        background: 'color-mix(in oklab, #14F195 8%, transparent)',
        border: '1px solid color-mix(in oklab, #14F195 30%, transparent)',
        color: '#14F195', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Icon name="check" size={13} stroke={2} />
        CLI wallet loaded · {addr.slice(0, 6)}…{addr.slice(-4)}
      </div>
    );
  }

  return (
    <div>
      <Btn
        variant="secondary" size="sm" icon="wallet"
        disabled={status === 'loading'}
        onClick={load}
      >
        {status === 'loading' ? 'Loading…' : 'Test with CLI wallet'}
      </Btn>
      {err && <p style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>{err}</p>}
    </div>
  );
}

// ─── DepositPanel ─────────────────────────────────────────────────────────────

function DepositPanel({ onDeposited, onTx }: {
  onDeposited: (amount: number, price: number) => void;
  onTx: (e: TxEvent) => void;
}) {
  const wallet = useWallet();
  const [devKeypair, setDevKeypair] = useState<Keypair | null>(null);
  const { status: positionStatus, recheck } = usePositionAccount();
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);

  // Returns an anchor wallet from the CLI keypair (if loaded) or Phantom.
  const getAnchorWallet = () => {
    if (devKeypair) return makeKeypairWallet(devKeypair);
    return makeAnchorWallet(wallet);
  };

  const canSign = devKeypair !== null || (wallet.connected && !!wallet.publicKey);

  const handleInitPosition = async () => {
    setErr(null);
    setLogs(null);
    const aw = getAnchorWallet();
    const provider = makeProvider(aw);
    const program = makeProgram(provider);
    await txCreatePosition(program, aw);
    recheck();
  };

  const handleDeposit = async () => {
    setErr(null);
    setInfo(null);
    setLogs(null);
    const amtNum = parseFloat(amount);
    const priceNum = parseFloat(price);
    if (!amtNum || !priceNum) throw new Error('Enter amount and price');
    if (!canSign) throw new Error('Connect wallet or load CLI keypair');

    try {
      await withRetry(async () => {
        const aw = getAnchorWallet();
        const provider = makeProvider(aw);
        const program = makeProgram(provider);
        const mxeKey = await getMxeKey(provider);
        const { publicKey, cipher } = await setupCipher(mxeKey);
        const { ciphertexts, nonce } = encryptDeposit(
          cipher,
          BigInt(Math.round(amtNum * 1e6)),
          BigInt(Math.round(priceNum * 1e6)),
        );
        const result = await txDeposit(program, aw, publicKey, ciphertexts, nonce);

        onDeposited(amtNum, priceNum);
        onTx({
          id: result.sig,
          type: 'deposit',
          label: 'Deposit collateral',
          detail: `${amtNum} SOL @ $${priceNum}`,
          signature: result.sig,
          timestamp: Date.now(),
          ok: true,
        });
        setAmount('');
        setPrice('');

        if (!result.mpcFinalized && result.mpcError) {
          setInfo(result.mpcError);
        }
      });
    } catch (e: unknown) {
      const anyErr = e as { message?: string; logs?: string[] };
      console.error('[deposit] Full error object:', JSON.stringify(e, Object.getOwnPropertyNames(e as object), 2));
      console.error('[deposit] Error message:', anyErr.message);
      console.error('[deposit] Solana logs:', anyErr.logs);
      if (anyErr.logs?.length) setLogs(anyErr.logs);
      throw e;
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <Icon name="lock" size={16} stroke={1.6} />
          Deposit collateral
        </div>
        <Pill tone="encrypted" icon="lock">Encrypted on-chain</Pill>
      </div>

      {/* Dev-only: load CLI keypair to bypass Phantom */}
      {process.env.NODE_ENV === 'development' && (
        <div style={{ marginBottom: 14 }}>
          <DevWalletButton onKeypair={(kp) => { setDevKeypair(kp); recheck(); }} />
        </div>
      )}

      {/* ── Step 1: initialize position if it doesn't exist yet ── */}
      {positionStatus === 'missing' && (
        <>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
            No on-chain position found for this wallet. Initialize one before depositing.
          </p>
          <EncryptingButton
            label="Initialize Position"
            icon="lock"
            disabled={!canSign}
            onAction={handleInitPosition}
          />
          {err && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{err}</p>}
          {logs && (
            <pre style={{
              marginTop: 8, padding: '8px 10px', borderRadius: 6, fontSize: 10,
              background: 'var(--surface-0)', border: '1px solid var(--border-soft)',
              color: 'var(--danger)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {logs.join('\n')}
            </pre>
          )}
        </>
      )}

      {positionStatus === 'loading' && (
        <p style={{ fontSize: 13, color: 'var(--fg-dim)' }}>Checking on-chain position…</p>
      )}

      {positionStatus === 'disconnected' && (
        <p style={{ fontSize: 13, color: 'var(--fg-dim)' }}>Connect wallet to continue.</p>
      )}

      {/* ── Step 2: deposit form (only when position exists) ── */}
      {positionStatus === 'exists' && (
        <>
          <div className="input-group">
            <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <div className="suffix">SOL</div>
          </div>

          <div style={{ height: 10 }} />

          <div className="input-group">
            <input inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} />
            <div className="suffix">USD / SOL</div>
          </div>

          {price && amount && (
            <div className="field-meta">
              <span>≈ ${(parseFloat(amount) * parseFloat(price) || 0).toFixed(2)} at ${price} / SOL</span>
            </div>
          )}

          <div style={{ height: 16 }} />
          <EncryptingButton label="Deposit" icon="lock" disabled={!canSign} onAction={handleDeposit} />

          {err && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{err}</p>}
          {info && <p style={{ color: 'var(--warn)', fontSize: 12, marginTop: 8 }}>{info}</p>}
          {logs && (
            <pre style={{
              marginTop: 8, padding: '8px 10px', borderRadius: 6, fontSize: 10,
              background: 'var(--surface-0)', border: '1px solid var(--border-soft)',
              color: 'var(--danger)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {logs.join('\n')}
            </pre>
          )}
        </>
      )}

      <div className="field-meta" style={{ marginTop: 12 }}>
        <span>Position stored as ciphertext. Validators never see the amount.</span>
      </div>
    </section>
  );
}

// ─── BorrowPanel ──────────────────────────────────────────────────────────────

function BorrowPanel({ collateralAmount, collateralPrice, currentBorrow, onBorrowed, onTx }: {
  collateralAmount: number; collateralPrice: number; currentBorrow: number;
  onBorrowed: (amount: number) => void; onTx: (e: TxEvent) => void;
}) {
  const wallet = useWallet();
  const [amount, setAmount] = useState('');
  const [lastApproved, setLastApproved] = useState<boolean | null>(null);

  const collateralUsd = collateralAmount * collateralPrice;
  const amtNum = parseFloat(amount) || 0;
  const totalBorrow = currentBorrow + amtNum;
  const ltv = collateralUsd > 0 ? (totalBorrow / collateralUsd) * 100 : 0;
  const overCap = ltv > LTV_MAX_PCT;
  const maxBorrow = Math.max(0, collateralUsd * (LTV_MAX_PCT / 100) - currentBorrow);

  const handleBorrow = async () => {
    if (!amtNum) throw new Error('Enter amount');
    if (!wallet.connected || !wallet.publicKey) throw new Error('Connect wallet');

    const aw = makeAnchorWallet(wallet);
    const provider = makeProvider(aw);
    const program = makeProgram(provider);
    const mxeKey = await getMxeKey(provider);
    const { publicKey, cipher } = await setupCipher(mxeKey);
    const { ciphertexts, nonce } = encryptBorrow(
      cipher,
      BigInt(Math.round(collateralAmount * 1e6)),
      BigInt(Math.round(currentBorrow * 1e6)),
    );
    const result = await txBorrow(
      program, aw, publicKey, ciphertexts, nonce,
      Math.round(amtNum * 1e6),
      Math.round(collateralPrice * 1e6),
    );

    setLastApproved(result.approved);
    if (result.approved) {
      onBorrowed(amtNum);
      onTx({ id: result.sig, type: 'borrow', label: 'Borrow approved', detail: `$${amtNum.toFixed(2)} — ${ltv.toFixed(1)}% LTV`, signature: result.sig, timestamp: Date.now(), ok: true });
      setAmount('');
    } else {
      onTx({ id: result.sig, type: 'borrow', label: 'Borrow rejected', detail: 'MPC: would exceed LTV cap', timestamp: Date.now(), ok: false });
      throw new Error('Rejected by MPC');
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <Icon name="arrow-down-up" size={16} stroke={1.6} />
          Borrow against collateral
        </div>
        <Pill tone={overCap ? 'danger' : 'neutral'}>
          {overCap ? `Exceeds ${LTV_MAX_PCT}% cap` : 'Within cap'}
        </Pill>
      </div>

      <div className="input-group">
        <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="suffix">USDC</div>
      </div>
      <div className="field-meta">
        <span>New total debt: ${totalBorrow.toFixed(2)}</span>
        <span className="max" onClick={() => setAmount(maxBorrow.toFixed(2))}>Max · {maxBorrow.toFixed(2)}</span>
      </div>

      <div style={{ height: 18 }} />
      <LtvBar ltv={ltv} cap={LTV_MAX_PCT} />
      <div style={{ height: 18 }} />

      {lastApproved === false && (
        <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>
          MPC rejected — LTV would exceed cap
        </p>
      )}

      <EncryptingButton
        label="Borrow" icon="lock"
        disabled={!wallet.connected || overCap || !collateralAmount}
        onAction={handleBorrow}
      />

      <div className="field-meta" style={{ marginTop: 12 }}>
        <span>
          LTV check runs inside MPC. Only{' '}
          <span style={{ color: 'var(--fg)' }}>approved: bool</span> is revealed on-chain.
        </span>
      </div>
    </section>
  );
}

// ─── HealthPanel ──────────────────────────────────────────────────────────────

function HealthPanel({ health, healthTone, encrypted, collateralAmount, collateralPrice, borrowAmount, interestAccrued, onDecrypt, onTx }: {
  health: number; healthTone: string; encrypted: boolean;
  collateralAmount: number; collateralPrice: number; borrowAmount: number; interestAccrued: number;
  onDecrypt: (hf: number) => void; onTx: (e: TxEvent) => void;
}) {
  const wallet = useWallet();
  const [decrypting, setDecrypting] = useState(false);

  const handleDecrypt = async () => {
    if (!wallet.connected || !wallet.publicKey || decrypting) return;
    setDecrypting(true);
    try {
      const aw = makeAnchorWallet(wallet);
      const provider = makeProvider(aw);
      const program = makeProgram(provider);
      const mxeKey = await getMxeKey(provider);
      const { publicKey, cipher } = await setupCipher(mxeKey);
      const { ciphertexts, nonce } = encryptHealth(
        cipher,
        BigInt(Math.round(collateralAmount * 1e6)),
        BigInt(Math.round(borrowAmount * 1e6)),
        BigInt(Math.round(interestAccrued * 1e6)),
      );
      const result = await txComputeHealthFactor(
        program, aw, publicKey, ciphertexts, nonce,
        Math.round(collateralPrice * 1e6),
      );
      const hf = decryptHealthFactor(cipher, result.encryptedCollateralScaled, result.encryptedTotalDebt, result.nonce);
      onDecrypt(hf);
      onTx({ id: Date.now().toString(), type: 'health', label: 'Health-factor read', detail: `HF = ${hf.toFixed(2)} — result encrypted to wallet`, timestamp: Date.now(), ok: true });
    } finally {
      setDecrypting(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <Icon name="shield-check" size={16} stroke={1.6} />
          Health factor
        </div>
        {encrypted ? (
          <button
            className="btn btn-ghost btn-sm"
            disabled={decrypting || !wallet.connected}
            onClick={handleDecrypt}
          >
            <Icon name={decrypting ? 'refresh-cw' : 'lock-open'} size={13} stroke={1.8} />
            <span>{decrypting ? 'Decrypting…' : 'Decrypt'}</span>
          </button>
        ) : (
          <Pill tone={healthTone === 'good' ? 'success' : healthTone === 'warn' ? 'warn' : 'danger'}>
            {healthLabel(healthTone)}
          </Pill>
        )}
      </div>

      <div className="hf">
        {encrypted
          ? <div className="display cipher">••••</div>
          : <div className="v" style={{ color: healthColor(healthTone) }}>{health.toFixed(2)}</div>}
        <div>
          <div className="lbl" style={{ color: encrypted ? 'var(--fg-dim)' : healthColor(healthTone) }}>
            {encrypted ? 'Encrypted' : healthLabel(healthTone)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Liquidates at HF &lt; 1.00
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 18 }}>
        <HFStop tone="good" range="> 1.5"    active={!encrypted && healthTone === 'good'} />
        <HFStop tone="warn" range="1.0 – 1.5" active={!encrypted && healthTone === 'warn'} />
        <HFStop tone="bad"  range="< 1.0"   active={!encrypted && healthTone === 'bad'} />
      </div>
    </section>
  );
}

// ─── InterestPanel ────────────────────────────────────────────────────────────

function InterestPanel({ interest, borrowAmount, encrypted, onAccrued, onTx }: {
  interest: number; borrowAmount: number; encrypted: boolean;
  onAccrued: (inc: number) => void; onTx: (e: TxEvent) => void;
}) {
  const wallet = useWallet();
  const [days, setDays] = useState('30');
  const apr = 5.0;
  const rateBps = apr * 100;
  const elapsedSecs = parseFloat(days) * 86400 || 0;
  const increment = borrowAmount > 0 ? (borrowAmount * rateBps * elapsedSecs) / 315_360_000_000 : 0;

  const handleAccrue = async () => {
    if (!wallet.connected || !wallet.publicKey) throw new Error('Connect wallet');

    const aw = makeAnchorWallet(wallet);
    const provider = makeProvider(aw);
    const program = makeProgram(provider);
    const mxeKey = await getMxeKey(provider);
    const { publicKey, cipher } = await setupCipher(mxeKey);
    const { ciphertexts, nonce } = encryptInterest(
      cipher,
      BigInt(Math.round(borrowAmount * 1e6)),
      BigInt(Math.round(interest * 1e6)),
    );
    const inc = computeInterestIncrement(
      BigInt(Math.round(borrowAmount * 1e6)),
      BigInt(Math.round(rateBps)),
      BigInt(Math.round(elapsedSecs)),
    );
    await txAccrueInterest(program, aw, publicKey, ciphertexts, nonce, inc);

    onAccrued(increment);
    onTx({ id: Date.now().toString(), type: 'interest', label: 'Accrue interest', detail: `+$${increment.toFixed(4)} · ${days}d · ${apr}% APR`, timestamp: Date.now(), ok: true });
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <Icon name="clock" size={16} stroke={1.6} />
          Interest accrual
        </div>
        <Pill tone="info">{apr.toFixed(1)}% APR</Pill>
      </div>

      <div className="hf" style={{ paddingBottom: 12 }}>
        {encrypted
          ? <div className="display cipher">••••</div>
          : (
            <div style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: "'tnum'", fontSize: 'var(--text-display)', fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1, color: 'var(--fg)' }}>
              ${interest.toFixed(2)}
            </div>
          )}
        <div>
          <div className="lbl" style={{ color: 'var(--fg-dim)' }}>Accrued · {days}d</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Preview:{' '}
            <span className="tnum" style={{ color: 'var(--fg-muted)' }}>
              +${increment.toFixed(4)}
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Days to accrue</span>
        <input
          type="number" min="1" value={days}
          onChange={(e) => setDays(e.target.value)}
          style={{
            width: 72, background: 'var(--surface-0)', border: '1px solid var(--border-soft)',
            borderRadius: 6, padding: '4px 8px', color: 'var(--fg)',
            fontFamily: 'var(--font-mono)', fontSize: 13,
          }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <EncryptingButton
          label="Accrue now" icon="refresh-cw" variant="secondary"
          disabled={!wallet.connected || !borrowAmount}
          onAction={handleAccrue}
        />
        <Btn variant="ghost" block icon="external-link">View circuit</Btn>
      </div>
    </section>
  );
}

// ─── TxHistory ────────────────────────────────────────────────────────────────

const TX_ICON: Record<string, string> = {
  deposit: 'lock', borrow: 'arrow-down-up', health: 'shield-check',
  interest: 'clock', liquidation: 'circle-alert',
};

function TxHistory({ events }: { events: TxEvent[] }) {
  const rows = [...events].reverse();
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 4px 12px' }}>
        <h2 style={{ fontSize: 'var(--text-h2)' }}>Transaction history</h2>
        <Btn variant="ghost" size="sm" iconRight="external-link">Open in Solscan</Btn>
      </div>
      <div className="tx-table">
        <div className="tx-head">
          <span />
          <span>Operation</span>
          <span>Status</span>
          <span>Amount</span>
          <span>Signature</span>
          <span style={{ textAlign: 'right' }}>Time</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--fg-dim)', fontSize: 13 }}>
            No transactions yet — connect a wallet and make a deposit.
          </div>
        ) : rows.map((t) => (
          <div className="tx-row" key={t.id}>
            <span className="ico">
              <Icon name={TX_ICON[t.type] ?? 'lock'} size={18} stroke={1.5} />
            </span>
            <div className="op-col">
              <span className="op">{t.label}</span>
              <span className="meta">{t.detail}</span>
            </div>
            <Pill tone={t.ok ? (t.type === 'deposit' ? 'encrypted' : 'success') : 'danger'} dot>
              {t.ok ? (t.type === 'deposit' ? 'Encrypted' : 'Success') : 'Failed'}
            </Pill>
            <span className="amt">
              {t.signature ? <Cipher width={6} /> : '—'}
            </span>
            <span className="meta" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {t.signature
                ? `${t.signature.slice(0, 4)}…${t.signature.slice(-4)}`
                : '—'}
              {t.signature && (
                <Icon name="copy" size={11} style={{ color: 'var(--fg-faint)', cursor: 'pointer' }} />
              )}
            </span>
            <span className="time">{new Date(t.timestamp).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── App (page) ───────────────────────────────────────────────────────────────

export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Position state
  const [collateralAmount, setCollateralAmount] = useState(0);
  const [collateralPrice, setCollateralPrice]   = useState(0);
  const [borrowAmount, setBorrowAmount]           = useState(0);
  const [interestAccrued, setInterestAccrued]     = useState(0);
  const [healthFactor, setHealthFactor]           = useState<number | null>(null);
  const [encrypted, setEncrypted]                 = useState(true);
  const [txEvents, setTxEvents]                   = useState<TxEvent[]>([]);

  function addTx(e: TxEvent) { setTxEvents((p) => [...p, e]); }

  const collateralUsd = collateralAmount * collateralPrice;
  const totalDebt     = borrowAmount + interestAccrued;
  const health        = healthFactor ?? (totalDebt > 0 ? (collateralUsd * 0.85) / totalDebt : 9.99);
  const healthTone    = healthToneFor(health);
  const ltv           = collateralUsd > 0 ? (borrowAmount / collateralUsd) * 100 : 0;

  if (!mounted) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <span style={{ color: 'var(--fg-dim)', fontSize: 14 }}>Loading…</span>
      </div>
    );
  }

  return (
    <div className="app">
      <TopNav />
      <main className="container page">

        {/* Page header */}
        <div className="page-head">
          <div>
            <h1 className="page-title">Borrower dashboard</h1>
            <div className="page-sub">
              Confidential lending on Solana via Arcium MPC. Position stored encrypted; only{' '}
              <span className="tnum" style={{ color: 'var(--fg)' }}>approved: bool</span> is revealed on-chain.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn
              variant="secondary" size="sm"
              icon={encrypted ? 'lock' : 'lock-open'}
              onClick={() => { setEncrypted(!encrypted); if (encrypted) setHealthFactor(null); }}
            >
              {encrypted ? 'Encrypted view' : 'Decrypted view'}
            </Btn>
            <Btn variant="secondary" size="sm" icon="refresh-cw">Sync</Btn>
          </div>
        </div>

        {/* Metric cards */}
        <MetricRow
          collateral={collateralUsd}
          borrowed={borrowAmount}
          ltv={ltv}
          health={health}
          healthTone={healthTone}
          interest={interestAccrued}
          encrypted={encrypted}
        />

        {/* Action panels */}
        <div className="row-2">
          <DepositPanel
            onDeposited={(amt, price) => {
              setCollateralAmount(amt);
              setCollateralPrice(price);
              setEncrypted(true);
              setHealthFactor(null);
            }}
            onTx={addTx}
          />
          <BorrowPanel
            collateralAmount={collateralAmount}
            collateralPrice={collateralPrice}
            currentBorrow={borrowAmount}
            onBorrowed={(amt) => {
              setBorrowAmount((p) => p + amt);
              setEncrypted(true);
              setHealthFactor(null);
            }}
            onTx={addTx}
          />
        </div>

        {/* Info panels */}
        <div className="row-2">
          <HealthPanel
            health={health}
            healthTone={healthTone}
            encrypted={encrypted}
            collateralAmount={collateralAmount}
            collateralPrice={collateralPrice}
            borrowAmount={borrowAmount}
            interestAccrued={interestAccrued}
            onDecrypt={(hf) => { setHealthFactor(hf); setEncrypted(false); }}
            onTx={addTx}
          />
          <InterestPanel
            interest={interestAccrued}
            borrowAmount={borrowAmount}
            encrypted={encrypted}
            onAccrued={(inc) => {
              setInterestAccrued((p) => +(p + inc).toFixed(6));
              setEncrypted(true);
              setHealthFactor(null);
            }}
            onTx={addTx}
          />
        </div>

        {/* Tx history */}
        <TxHistory events={txEvents} />

      </main>
    </div>
  );
}
