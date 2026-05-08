# Private Credit — Confidential Lending on Solana via Arcium MPC

A privacy-preserving lending protocol built on Solana using [Arcium](https://arcium.com). Collateral amounts, borrow positions, and health factors never appear on-chain in plaintext. All sensitive computations run inside Arcium's multi-party computation (MPC) cluster, and only the minimum necessary information is revealed.

## What It Does

Traditional on-chain lending (Aave, Compound, MarginFi) exposes every position publicly: collateral size, borrow amount, liquidation threshold. Anyone can watch for undercollateralized positions and front-run liquidations. Private Credit eliminates this:

| Operation | What's revealed on-chain |
|-----------|--------------------------|
| Deposit collateral | Nothing (position stored encrypted) |
| Borrow against collateral | Whether the borrow was approved (`true`/`false`) |
| Check health factor | Encrypted result — only the borrower can decrypt |
| Check liquidatability | Boolean only — liquidators see `true` or `false`, never the numbers |
| Accrue interest | Nothing (debt updated privately inside MPC) |

## The 5 MPC Circuits

All circuits are defined in [`encrypted-ixs/src/lib.rs`](encrypted-ixs/src/lib.rs) using the Arcium ARCIS circuit language and compiled to `.arcis` bytecode.

### 1. `deposit` (~481M ACUs)
Accepts encrypted `{ collateral_amount: u64, collateral_price: u64 }` and stores it back under the owner's shared key. A pure pass-through — the ciphertext is re-wrapped under the MXE's key so it can participate in future MPC computations without the user being online.

### 2. `borrow` (~506M ACUs)
Checks LTV without division:
```
approved = (existing_borrow + new_borrow) * 100 <= collateral_amount * asset_price * 80
```
The `approved` bool is revealed. If approved, the updated borrow amount is stored encrypted. The 80% LTV cap is enforced inside MPC — the validator never sees the raw numbers.

### 3. `compute_health_factor` (~485M ACUs)
Returns encrypted `(collateral_scaled, total_debt)` to the borrower only:
```
collateral_scaled = collateral_amount * current_price * 85
total_debt = borrow_amount + interest_accrued
```
The client decrypts both values and computes `health = collateral_scaled / total_debt` locally. Division stays off-chain; MPC handles only multiplication and addition.

### 4. `check_liquidatable` (~487M ACUs)
Reveals only whether a position is underwater:
```
liquidatable = (borrow + interest) * 100 > collateral * price * 85
```
Returns a single `bool`. Liquidators can monitor positions without learning collateral size, borrow amount, or anything else. The liquidation bot only knows which accounts are eligible.

### 5. `accrue_interest` (~481M ACUs)
Adds a precomputed interest increment to the encrypted debt:
```
interest_accrued += interest_increment
```
The increment is computed client-side:
```
interest_increment = borrow * rate_bps * elapsed_seconds / 315_360_000_000
```
Division is expensive in MPC. By computing the increment outside the circuit and passing it as plaintext, circuit cost drops dramatically.

## Key Design Decisions

### No Division in Circuits
Division in MPC requires secure division protocols that are orders of magnitude more expensive than multiplication. Every inequality in this protocol is algebraically rearranged to eliminate division:

| Naive (expensive) | Optimized (used here) |
|---|---|
| `borrow / collateral > 0.80` | `borrow * 100 > collateral * 80` |
| `health = (collateral * price * 0.85) / debt` | Return both sides; client divides |
| `interest = principal * rate / scale` | Client divides; circuit only adds |

This reduced circuit ACU counts by **69–90%** compared to the initial implementation with division.

### Liquidators See Only a Bool
The `check_liquidatable` circuit outputs exactly one bit. A liquidator service can poll every position and learn *which* accounts are eligible without learning collateral values, borrow sizes, or anything that would enable front-running of other positions or targeted attacks on large borrowers.

### Borrowers Decrypt Their Own Health Factor
`compute_health_factor` returns output encrypted under the borrower's ephemeral X25519 key (provided at call time). Only the borrower can decrypt the result. Third parties cannot learn health factors even by watching on-chain events.

### Per-Circuit Minimal Structs
Each circuit operates on exactly the fields it needs — no more:

```rust
// Deposit: just the two amounts that define the position
struct DepositData { collateral_amount: u64, collateral_price: u64 }

// Borrow: collateral + current debt
struct BorrowData { collateral_amount: u64, borrow_amount: u64 }

// Health / liquidation: full position including accrued interest
struct HealthData { collateral_amount: u64, borrow_amount: u64, interest_accrued: u64 }

// Interest update: just the debt fields
struct InterestData { borrow_amount: u64, interest_accrued: u64 }
```

Narrower structs mean smaller ciphertexts, fewer encrypted field operations, and lower ACU cost per computation.

## Project Structure

```
private_credit/
├── programs/private_credit/src/lib.rs   Anchor program — instruction routing, account
│                                        validation, computation queuing, MPC callbacks,
│                                        event emission
├── encrypted-ixs/src/lib.rs             ARCIS circuits — all private computation logic
├── tests/private_credit.ts              Integration tests — full end-to-end MPC flow
├── build/                               Compiled .arcis circuit bytecode (gitignored)
├── artifacts/                           Deployment artifacts (gitignored)
└── app/                                 Next.js borrower dashboard
    ├── app/page.tsx                     Main UI — deposit, borrow, health, interest panels
    ├── app/api/dev-keypair/route.ts     Dev-only API route — loads CLI wallet for testing
    ├── lib/program.ts                   Anchor client — all 5 tx functions + MPC error handling
    ├── lib/crypto.ts                    RescueCipher encrypt/decrypt helpers
    ├── lib/constants.ts                 Program ID, RPC endpoint, LTV cap
    ├── providers/WalletProvider.tsx     Solana wallet adapter (Wallet Standard, auto-detect)
    └── lib/idl.json                     Generated Anchor IDL
```

The Anchor program handles everything that can be public. The ARCIS circuits handle everything that must stay private. They communicate via the Arcium MPC cluster: the program queues a computation, the cluster executes it off-chain under MPC, and the result is delivered back via a callback instruction.

## Running Locally

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Arcium CLI](https://docs.arcium.com) | latest | `arcium build`, `arcium test`, `arcium deploy` |
| [Anchor](https://www.anchor-lang.com/docs/installation) | >= 0.31 | Solana program framework |
| [Solana CLI](https://docs.solanalabs.com/cli/install) | >= 2.0 | `solana-keygen`, `solana airdrop` |
| Docker | latest | Min 6 GB memory — for local Arcium arx nodes |
| Node.js | >= 18 | Frontend + test runner |
| Yarn | >= 1.22 | Workspace package manager |

### Build the circuits and program

```bash
arcium build
```

Expected output — all circuits well under 1B ACUs:

```
Built encrypted instruction weighing    505690820 ACUs, from build/borrow.arcis.ir.
Built encrypted instruction weighing    480628464 ACUs, from build/accrue_interest.arcis.ir.
Built encrypted instruction weighing    486629228 ACUs, from build/check_liquidatable.arcis.ir.
Built encrypted instruction weighing    485490072 ACUs, from build/compute_health_factor.arcis.ir.
Built encrypted instruction weighing    480627952 ACUs, from build/deposit.arcis.ir.
```

### Run integration tests (local MPC cluster)

```bash
ulimit -n 65536
arcium test
```

The test suite starts a local Solana validator, spins up Arcium arx nodes as Docker containers, initializes computation definitions, uploads circuit bytecode, creates a lending position, and runs all five MPC operations end-to-end.

> **Docker memory**: The arx node images are AMD64-only (run via Rosetta 2 on Apple Silicon). If Docker is allocated less than 6 GB, arx nodes may silently fail to process MPC computations and tests will time out. Increase memory in Docker Desktop → Settings → Resources before running.

### Run the frontend

```bash
cd app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The UI connects to Solana devnet and the deployed program automatically.

**First-time flow:**
1. Connect a Phantom/Backpack wallet (or click **Test with CLI wallet** in dev mode to use `~/.config/solana/id.json`)
2. The deposit panel checks for an on-chain `PositionAccount` PDA — if absent, an **Initialize Position** button appears
3. After initialization, the deposit form unlocks
4. All transactions route through the deployed devnet program and the Arcium MPC cluster

> The MXE circuits must be deployed to devnet for MPC finalization to complete. If only the Solana program is deployed, transactions confirm on-chain but MPC finalization will timeout with an informational message — the position is still updated.

## Deployed Program

| Network | Program ID |
|---------|-----------|
| Solana devnet | `B5BouEdmTShxjGb9vuP3Yoc5SU9fMjNzAhibmoS1YKQL` |

View on [Solana Explorer](https://explorer.solana.com/address/B5BouEdmTShxjGb9vuP3Yoc5SU9fMjNzAhibmoS1YKQL?cluster=devnet).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Solana (devnet) |
| Smart contract framework | Anchor 0.31 |
| MPC infrastructure | Arcium — ARCIS circuit language, MXE cluster |
| Encryption | RescueCipher (Arcium's MPC-native cipher) over X25519 key exchange |
| Frontend | Next.js 14, React 18, TypeScript |
| Wallet integration | `@solana/wallet-adapter-react` with Wallet Standard auto-detect |
| Anchor client | `@coral-xyz/anchor`, `@arcium-hq/client` |
| UI | CSS custom properties design system, Lucide icons, Geist font |

## License

MIT
