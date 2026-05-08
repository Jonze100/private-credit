// Anchor program interactions — client-side only
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Connection } from '@solana/web3.js';
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

export async function txDeposit(
  program: PrivateCreditProgram,
  wallet: anchor.Wallet,
  publicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: Uint8Array,
): Promise<string> {
  const computationOffset = randomOffset();
  const owner = wallet.publicKey;
  const position = getPositionPda(owner);
  const nonceBN = new BN(deserializeLE(nonce).toString());

  await program.methods
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

  await awaitComputationFinalization(
    program.provider as anchor.AnchorProvider,
    computationOffset,
    new PublicKey(PROGRAM_ID),
    'confirmed',
  );

  return computationOffset.toString();
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
