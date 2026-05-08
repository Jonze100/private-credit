// All crypto helpers — only called client-side (inside event handlers / useEffect)
import type { RescueCipher as RescueCipherType } from '@arcium-hq/client';
import { INTEREST_SCALE } from './constants';

export function browserRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export async function loadCipher(): Promise<typeof import('@arcium-hq/client')> {
  return import('@arcium-hq/client');
}

export async function setupCipher(mxePublicKey: Uint8Array) {
  const { x25519, RescueCipher } = await loadCipher();
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  return { privateKey, publicKey, cipher };
}

function toUint8Arrays(raw: number[][]): Uint8Array[] {
  return raw.map((ct) => new Uint8Array(ct));
}

export function encryptDeposit(
  cipher: RescueCipherType,
  collateralAmount: bigint,
  collateralPrice: bigint,
) {
  const nonce = browserRandomBytes(16);
  const ciphertexts = toUint8Arrays(cipher.encrypt([collateralAmount, collateralPrice], nonce));
  return { nonce, ciphertexts };
}

export function encryptBorrow(
  cipher: RescueCipherType,
  collateralAmount: bigint,
  borrowAmount: bigint,
) {
  const nonce = browserRandomBytes(16);
  const ciphertexts = toUint8Arrays(cipher.encrypt([collateralAmount, borrowAmount], nonce));
  return { nonce, ciphertexts };
}

export function encryptHealth(
  cipher: RescueCipherType,
  collateralAmount: bigint,
  borrowAmount: bigint,
  interestAccrued: bigint,
) {
  const nonce = browserRandomBytes(16);
  const ciphertexts = toUint8Arrays(cipher.encrypt([collateralAmount, borrowAmount, interestAccrued], nonce));
  return { nonce, ciphertexts };
}

export function encryptInterest(
  cipher: RescueCipherType,
  borrowAmount: bigint,
  interestAccrued: bigint,
) {
  const nonce = browserRandomBytes(16);
  const ciphertexts = toUint8Arrays(cipher.encrypt([borrowAmount, interestAccrued], nonce));
  return { nonce, ciphertexts };
}

export function computeInterestIncrement(
  borrowAmount: bigint,
  rateBps: bigint,
  elapsedSeconds: bigint,
): bigint {
  return (borrowAmount * rateBps * elapsedSeconds) / INTEREST_SCALE;
}

export function decryptHealthFactor(
  cipher: RescueCipherType,
  encryptedCollateralScaled: number[],
  encryptedTotalDebt: number[],
  nonce: number[],
): number {
  const decrypted = cipher.decrypt(
    [encryptedCollateralScaled, encryptedTotalDebt],
    new Uint8Array(nonce),
  );
  const collateralScaled = decrypted[0];
  const totalDebt = decrypted[1];
  if (totalDebt === BigInt(0)) return 9999;
  return Number((collateralScaled * BigInt(100)) / totalDebt) / 100;
}
