import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PrivateCredit } from "../target/types/private_credit";
import {
  getArciumEnv,
  getArciumProgram,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getLookupTableAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  awaitComputationFinalization,
  uploadCircuit,
  RescueCipher,
  x25519,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as os from "os";
import * as fs from "fs";

function readKpJson(path: string): anchor.web3.Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (e) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, e);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

describe("private_credit", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.PrivateCredit as Program<PrivateCredit>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumEnv = getArciumEnv();
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  async function setupCipher() {
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    return { privateKey, publicKey, cipher };
  }

  // DepositData: { collateral_amount: u64, collateral_price: u64 }
  function encryptDeposit(
    cipher: RescueCipher,
    collateralAmount: bigint,
    collateralPrice: bigint
  ) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt([collateralAmount, collateralPrice], nonce);
    return { nonce, ciphertexts };
  }

  // BorrowData: { collateral_amount: u64, borrow_amount: u64 }
  function encryptBorrow(
    cipher: RescueCipher,
    collateralAmount: bigint,
    borrowAmount: bigint
  ) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt([collateralAmount, borrowAmount], nonce);
    return { nonce, ciphertexts };
  }

  // HealthData: { collateral_amount: u64, borrow_amount: u64, interest_accrued: u64 }
  function encryptHealth(
    cipher: RescueCipher,
    collateralAmount: bigint,
    borrowAmount: bigint,
    interestAccrued: bigint
  ) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt([collateralAmount, borrowAmount, interestAccrued], nonce);
    return { nonce, ciphertexts };
  }

  // InterestData: { borrow_amount: u64, interest_accrued: u64 }
  function encryptInterest(
    cipher: RescueCipher,
    borrowAmount: bigint,
    interestAccrued: bigint
  ) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt([borrowAmount, interestAccrued], nonce);
    return { nonce, ciphertexts };
  }

  function getBaseAccounts(computationOffset: anchor.BN) {
    return {
      computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
      clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    };
  }

  function getCompDef(name: string) {
    return getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset(name)).readUInt32LE()
    );
  }

  function getPositionPda() {
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), owner.publicKey.toBuffer()],
      program.programId
    );
    return pda;
  }

  it("inits all computation definitions", async () => {
    const arciumProgram = getArciumProgram(provider);
    const mxeAddress = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAddress);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

    for (const name of [
      "deposit",
      "borrow",
      "compute_health_factor",
      "check_liquidatable",
      "accrue_interest",
    ]) {
      const methodName = `init${name
        .split("_")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("")}CompDef`;

      try {
        await (program.methods as any)
          [methodName]()
          .accountsPartial({
            compDefAccount: getCompDef(name),
            mxeAccount: mxeAddress,
            addressLookupTable: lutAddress,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });
        console.log(`✅ init ${name} comp def`);
      } catch (e: any) {
        if (e.message?.includes("already in use")) {
          console.log(`⏭ ${name} comp def already exists`);
        } else throw e;
      }

      const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
      await uploadCircuit(
        provider,
        name,
        program.programId,
        rawCircuit,
        true,
        500,
        { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" }
      );
      console.log(`✅ uploaded ${name} circuit`);
    }
  });

  it("creates a position account", async () => {
    try {
      await program.methods
        .createPosition()
        .accounts({ owner: owner.publicKey })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
      console.log("✅ Position account created");
    } catch (e: any) {
      if (e.message?.includes("already in use")) {
        console.log("⏭ Position already exists");
      } else throw e;
    }
  });

  it("deposits collateral — position stored encrypted", async () => {
    const { publicKey, cipher } = await setupCipher();
    const positionPda = getPositionPda();

    // DepositData: collateral=1000, price=$2
    const { nonce, ciphertexts } = encryptDeposit(cipher, BigInt(1000), BigInt(2));

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const depositPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("depositEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .deposit(
        computationOffset,
        Array.from(ciphertexts[0]), // collateral_amount_ct
        Array.from(ciphertexts[1]), // collateral_price_ct
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("deposit"),
        position: positionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");

    const event = await depositPromise;
    console.log("✅ Collateral deposited — position encrypted onchain");
    console.log("   Owner:", event.owner.toString());
  });

  it("borrows against collateral — LTV check inside MPC", async () => {
    const { publicKey, cipher } = await setupCipher();
    const positionPda = getPositionPda();

    // BorrowData: collateral=1000, existing_borrow=0
    const { nonce, ciphertexts } = encryptBorrow(cipher, BigInt(1000), BigInt(0));

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const borrowPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("borrowEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .borrow(
        computationOffset,
        Array.from(ciphertexts[0]), // collateral_amount_ct
        Array.from(ciphertexts[1]), // borrow_amount_ct
        new anchor.BN(1200),        // new_borrow: $1200 (max 80% of 1000*2=$2000 → $1600)
        new anchor.BN(2),           // asset_price: $2
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("borrow"),
        position: positionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");

    const event = await borrowPromise;
    console.log("✅ Borrow processed inside MPC");
    console.log("   Approved:", event.approved);
    // 1200*100=120000 <= 1000*2*80=160000 → approved
  });

  it("checks health factor — only borrower decrypts result", async () => {
    const { publicKey, cipher } = await setupCipher();
    const positionPda = getPositionPda();

    // HealthData: collateral=1000, borrow=1200, interest=0
    const { nonce, ciphertexts } = encryptHealth(cipher, BigInt(1000), BigInt(1200), BigInt(0));

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const healthPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("healthFactorEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .computeHealthFactor(
        computationOffset,
        Array.from(ciphertexts[0]), // collateral_amount_ct
        Array.from(ciphertexts[1]), // borrow_amount_ct
        Array.from(ciphertexts[2]), // interest_accrued_ct
        new anchor.BN(2),           // current_price: $2
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("compute_health_factor"),
        position: positionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");

    const event = await healthPromise;
    // Decrypt (collateral_scaled, total_debt) and compute ratio client-side
    const decrypted = cipher.decrypt(
      [event.encryptedCollateralScaled, event.encryptedTotalDebt],
      new Uint8Array(event.nonce)
    );
    const collateralScaled = decrypted[0]; // collateral * price * 85 = 1000*2*85 = 170000
    const totalDebt = decrypted[1];        // borrow + interest = 1200+0 = 1200
    const health = totalDebt > 0n ? collateralScaled * 100n / totalDebt : 9999n;
    console.log("✅ Health factor computed — only borrower can decrypt");
    console.log("   collateral_scaled:", collateralScaled.toString());
    console.log("   total_debt:", totalDebt.toString());
    console.log("   health factor (scaled x100):", health.toString());
    // 170000 * 100 / 1200 = 14166 → healthy (>> 10000 baseline)
  });

  it("checks liquidatable — reveals only true/false", async () => {
    const { publicKey, cipher } = await setupCipher();
    const positionPda = getPositionPda();

    // HealthData: collateral=1000, borrow=1200, interest=0
    const { nonce, ciphertexts } = encryptHealth(cipher, BigInt(1000), BigInt(1200), BigInt(0));

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const liquidatablePromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("liquidatableEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .checkLiquidatable(
        computationOffset,
        Array.from(ciphertexts[0]), // collateral_amount_ct
        Array.from(ciphertexts[1]), // borrow_amount_ct
        Array.from(ciphertexts[2]), // interest_accrued_ct
        new anchor.BN(2),           // current_price: $2
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("check_liquidatable"),
        position: positionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");

    const event = await liquidatablePromise;
    console.log("✅ Liquidation check — only bool revealed");
    console.log("   Is liquidatable:", event.isLiquidatable);
    // lhs = 1200*100 = 120000, rhs = 1000*2*85 = 170000 → NOT liquidatable
  });

  it("accrues interest — debt updated privately", async () => {
    const { publicKey, cipher } = await setupCipher();
    const positionPda = getPositionPda();

    // Pre-compute interest increment client-side (no division inside MPC)
    // interest = borrow * rate_bps * time_secs / 315_360_000_000
    const borrowAmount = BigInt(1200);
    const rateBps = BigInt(500);           // 5% annual
    const timeElapsed = BigInt(2592000);   // 30 days in seconds
    const interestIncrement = borrowAmount * rateBps * timeElapsed / BigInt(315360000000);
    // = 1200 * 500 * 2592000 / 315360000000 = 1555200000000 / 315360000000 = 4

    // InterestData: borrow=1200, interest=0
    const { nonce, ciphertexts } = encryptInterest(cipher, borrowAmount, BigInt(0));

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const interestPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("interestAccruedEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .accrueInterest(
        computationOffset,
        Array.from(ciphertexts[0]),                         // borrow_amount_ct
        Array.from(ciphertexts[1]),                         // interest_accrued_ct
        new anchor.BN(interestIncrement.toString()),         // interest_increment (plaintext)
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("accrue_interest"),
        position: positionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");

    const event = await interestPromise;
    console.log("✅ Interest accrued — debt updated privately inside MPC");
    console.log("   Owner:", event.owner.toString());
    console.log("   Interest increment applied:", interestIncrement.toString());
  });
});
