// Anchor program interactions — client-side only
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  getMXEPublicKey,
  getMXEAccAddress,
  getClusterAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
} from '@arcium-hq/client';
import { PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, RPC_ENDPOINT } from './constants';
import idl from './idl.json';

export type PrivateCreditProgram = anchor.Program<anchor.Idl>;

// Creates an anchor.Wallet from a raw Keypair — used for dev/testing bypasses.
export function makeKeypairWallet(kp: Keypair): anchor.Wallet {
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([kp]);
      } else {
        (tx as Transaction).partialSign(kp);
      }
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      return txs.map((tx) => {
        if (tx instanceof VersionedTransaction) {
          tx.sign([kp]);
        } else {
          (tx as Transaction).partialSign(kp);
        }
        return tx;
      });
    },
  } as anchor.Wallet;
}

export function makeProvider(wallet: anchor.Wallet): anchor.AnchorProvider {
  const conn = new Connection(RPC_ENDPOINT, 'confirmed');
  return new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
}

export function makeProgram(provider: anchor.AnchorProvider): PrivateCreditProgram {
  return new anchor.Program(idl as anchor.Idl, provider);
}

export async function getMxeKey(provider: anchor.AnchorProvider): Promise<Uint8Array> {
  const key = await getMXEPublicKey(provider, new PublicKey(PROGRAM_ID));
  if (!key) throw new Error('MXE public key not found');
  return key;
}

function clusterBN(): BN {
  return new BN(ARCIUM_CLUSTER_OFFSET);
}

function getCompDef(name: string): PublicKey {
  return getCompDefAccAddress(
    new PublicKey(PROGRAM_ID),
    Buffer.from(getCompDefAccOffset(name)).readUInt32LE(),
  );
}

function getBaseAccounts(computationOffset: BN) {
  const clusterOffset = clusterBN();
  return {
    computationAccount: getComputationAccAddress(clusterOffset.toNumber(), computationOffset),
    clusterAccount: getClusterAccAddress(clusterOffset.toNumber()),
    mxeAccount: getMXEAccAddress(new PublicKey(PROGRAM_ID)),
    mempoolAccount: getMempoolAccAddress(clusterOffset.toNumber()),
    executingPool: getExecutingPoolAccAddress(clusterOffset.toNumber()),
  };
}

function getPositionPda(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), owner.toBuffer()],
    new PublicKey(PROGRAM_ID),
  );
  return pda;
}

function randomOffset(): BN {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return new BN(bytes);
}

function deserializeLE(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

export type TxResult = {
  sig: string;
  mpcFinalized: boolean;
  mpcError?: string;
};

function classifyMpcError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes('account') && (r.includes('not found') || r.includes('does not exist') || r.includes('accountnotfound'))) {
    return 'Transaction confirmed on-chain ✓  MXE circuits not yet uploaded to devnet — run `arcium deploy --cluster devnet` to initialize';
  }
  if (r.includes('timeout') || r.includes('timed out')) {
    return 'Transaction confirmed on-chain ✓  MPC finalization timed out — Arcium cluster may be congested';
  }
  if (r.includes('cluster') || r.includes('mempool') || r.includes('executing')) {
    return 'Transaction confirmed on-chain ✓  Arcium cluster accounts not found on devnet — circuits need to be deployed';
  }
  return `Transaction confirmed on-chain ✓  MPC finalization failed: ${raw}`;
}

export async function txCreatePosition(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
): Promise<string> {
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);

  console.log('[createPosition] sending transaction...');
  const sig = await program.methods
    .createPosition()
    .accountsPartial({ owner, position })
    .rpc({ commitment: 'confirmed' });
  console.log('[createPosition] confirmed:', sig);
  return sig;
}

export async function txDeposit(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
  publicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: Uint8Array,
): Promise<TxResult> {
  const computationOffset = randomOffset();
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);
  const nonceBN = new BN(deserializeLE(nonce).toString());

  console.log('[deposit] sending transaction...');
  const sig = await program.methods
    .deposit(
      computationOffset,
      Array.from(ciphertexts[0]),
      Array.from(ciphertexts[1]),
      Array.from(publicKey),
      nonceBN,
    )
    .accountsPartial({
      ...getBaseAccounts(computationOffset),
      compDefAccount: getCompDef('deposit'),
      position,
    })
    .rpc({ commitment: 'confirmed' });
  console.log('[deposit] transaction confirmed:', sig);

  console.log('[deposit] awaiting MPC finalization...');
  try {
    await awaitComputationFinalization(
      program.provider as anchor.AnchorProvider,
      computationOffset,
      new PublicKey(PROGRAM_ID),
      'confirmed',
    );
    console.log('[deposit] MPC finalized');
    return { sig, mpcFinalized: true };
  } catch (mpcErr) {
    const raw = mpcErr instanceof Error ? mpcErr.message : String(mpcErr);
    console.warn('[deposit] MPC finalization failed:', raw);
    return { sig, mpcFinalized: false, mpcError: classifyMpcError(raw) };
  }
}

export async function txBorrow(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
  publicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: Uint8Array,
  newBorrow: number,
  assetPrice: number,
): Promise<{ approved: boolean; sig: string }> {
  const computationOffset = randomOffset();
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);
  const nonceBN = new BN(deserializeLE(nonce).toString());

  let approved = false;
  const listener = program.addEventListener('borrowEvent', (e: { approved: boolean }) => {
    approved = e.approved;
    program.removeEventListener(listener);
  });

  await program.methods
    .borrow(
      computationOffset,
      Array.from(ciphertexts[0]),
      Array.from(ciphertexts[1]),
      new BN(newBorrow),
      new BN(assetPrice),
      Array.from(publicKey),
      nonceBN,
    )
    .accountsPartial({
      ...getBaseAccounts(computationOffset),
      compDefAccount: getCompDef('borrow'),
      position,
    })
    .rpc({ commitment: 'confirmed' });

  await awaitComputationFinalization(
    program.provider as anchor.AnchorProvider,
    computationOffset,
    new PublicKey(PROGRAM_ID),
    'confirmed',
  );

  return { approved, sig: computationOffset.toString() };
}

export async function txComputeHealthFactor(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
  publicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: Uint8Array,
  currentPrice: number,
): Promise<{ encryptedCollateralScaled: number[]; encryptedTotalDebt: number[]; nonce: number[] }> {
  const computationOffset = randomOffset();
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);
  const nonceBN = new BN(deserializeLE(nonce).toString());

  let eventResult: { encryptedCollateralScaled: number[]; encryptedTotalDebt: number[]; nonce: number[] } | null = null;
  const listener = program.addEventListener('healthFactorEvent', (e: { encryptedCollateralScaled: number[]; encryptedTotalDebt: number[]; nonce: number[] }) => {
    eventResult = e;
    program.removeEventListener(listener);
  });

  await program.methods
    .computeHealthFactor(
      computationOffset,
      Array.from(ciphertexts[0]),
      Array.from(ciphertexts[1]),
      Array.from(ciphertexts[2]),
      new BN(currentPrice),
      Array.from(publicKey),
      nonceBN,
    )
    .accountsPartial({
      ...getBaseAccounts(computationOffset),
      compDefAccount: getCompDef('compute_health_factor'),
      position,
    })
    .rpc({ commitment: 'confirmed' });

  await awaitComputationFinalization(
    program.provider as anchor.AnchorProvider,
    computationOffset,
    new PublicKey(PROGRAM_ID),
    'confirmed',
  );

  if (!eventResult) throw new Error('Health factor event not received');
  return eventResult;
}

export async function txCheckLiquidatable(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
  publicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: Uint8Array,
  currentPrice: number,
): Promise<boolean> {
  const computationOffset = randomOffset();
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);
  const nonceBN = new BN(deserializeLE(nonce).toString());

  let isLiquidatable = false;
  const listener = program.addEventListener('liquidatableEvent', (e: { isLiquidatable: boolean }) => {
    isLiquidatable = e.isLiquidatable;
    program.removeEventListener(listener);
  });

  await program.methods
    .checkLiquidatable(
      computationOffset,
      Array.from(ciphertexts[0]),
      Array.from(ciphertexts[1]),
      Array.from(ciphertexts[2]),
      new BN(currentPrice),
      Array.from(publicKey),
      nonceBN,
    )
    .accountsPartial({
      ...getBaseAccounts(computationOffset),
      compDefAccount: getCompDef('check_liquidatable'),
      position,
    })
    .rpc({ commitment: 'confirmed' });

  await awaitComputationFinalization(
    program.provider as anchor.AnchorProvider,
    computationOffset,
    new PublicKey(PROGRAM_ID),
    'confirmed',
  );

  return isLiquidatable;
}

export async function txAccrueInterest(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
  publicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: Uint8Array,
  interestIncrement: bigint,
): Promise<void> {
  const computationOffset = randomOffset();
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);
  const nonceBN = new BN(deserializeLE(nonce).toString());

  await program.methods
    .accrueInterest(
      computationOffset,
      Array.from(ciphertexts[0]),
      Array.from(ciphertexts[1]),
      new BN(interestIncrement.toString()),
      Array.from(publicKey),
      nonceBN,
    )
    .accountsPartial({
      ...getBaseAccounts(computationOffset),
      compDefAccount: getCompDef('accrue_interest'),
      position,
    })
    .rpc({ commitment: 'confirmed' });

  await awaitComputationFinalization(
    program.provider as anchor.AnchorProvider,
    computationOffset,
    new PublicKey(PROGRAM_ID),
    'confirmed',
  );
}
