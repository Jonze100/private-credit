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

## Architecture

```
programs/private_credit/src/lib.rs   Anchor program: instruction routing, account validation,
                                     queuing computations, receiving MPC callbacks, emitting events
encrypted-ixs/src/lib.rs             ARCIS circuits: all private computation logic
tests/private_credit.ts              Integration tests: full end-to-end MPC flow
build/                               Compiled .arcis circuit bytecode (gitignored)
```

The Anchor program handles everything that can be public. The ARCIS circuits handle everything that must stay private. They communicate via the Arcium MPC cluster: the program queues a computation, the cluster executes it off-chain under MPC, and the result is delivered back via a callback instruction.

## Building Locally

### Prerequisites
- [Arcium CLI](https://docs.arcium.com) (`arcium`)
- [Anchor](https://www.anchor-lang.com/docs/installation) >= 0.31
- [Solana CLI](https://docs.solanalabs.com/cli/install) >= 2.0
- Docker with **at least 6 GB memory allocated** (for local Arcium arx nodes)
- Node.js >= 18, Yarn

### Build

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

### Test

```bash
ulimit -n 65536
arcium test
```

The test suite starts a local Solana validator, spins up Arcium arx nodes as Docker containers, initializes computation definitions, uploads circuit bytecode, creates a lending position, and runs all five MPC operations end-to-end.

> **Docker memory**: The arx node images are AMD64-only (run via Rosetta 2 on Apple Silicon). If Docker is allocated less than 6 GB, arx nodes may silently fail to process MPC computations and tests will time out. Increase memory in Docker Desktop → Settings → Resources before running.

## Program ID

```
B5BouEdmTShxjGb9vuP3Yoc5SU9fMjNzAhibmoS1YKQL
```

## License

MIT
