use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_DEPOSIT: u32 = comp_def_offset("deposit");
const COMP_DEF_OFFSET_BORROW: u32 = comp_def_offset("borrow");
const COMP_DEF_OFFSET_COMPUTE_HEALTH_FACTOR: u32 = comp_def_offset("compute_health_factor");
const COMP_DEF_OFFSET_CHECK_LIQUIDATABLE: u32 = comp_def_offset("check_liquidatable");
const COMP_DEF_OFFSET_ACCRUE_INTEREST: u32 = comp_def_offset("accrue_interest");

declare_id!("B5BouEdmTShxjGb9vuP3Yoc5SU9fMjNzAhibmoS1YKQL");

#[arcium_program]
pub mod private_credit {
    use super::*;

    // ─── Init comp defs ───────────────────────────────────────────────────────

    pub fn init_deposit_comp_def(ctx: Context<InitDepositCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_borrow_comp_def(ctx: Context<InitBorrowCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_compute_health_factor_comp_def(ctx: Context<InitComputeHealthFactorCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_check_liquidatable_comp_def(ctx: Context<InitCheckLiquidatableCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_accrue_interest_comp_def(ctx: Context<InitAccrueInterestCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    // ─── Create Position ──────────────────────────────────────────────────────

    pub fn create_position(ctx: Context<CreatePosition>) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.owner.key();
        pos.is_active = false;
        pos.collateral_amount_ct = [0u8; 32];
        pos.collateral_price_ct = [0u8; 32];
        pos.borrow_amount_ct = [0u8; 32];
        pos.interest_accrued_ct = [0u8; 32];
        pos.nonce = [0u8; 16];
        Ok(())
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────
    // DepositData: { collateral_amount: u64, collateral_price: u64 }

    pub fn deposit(
        ctx: Context<Deposit>,
        computation_offset: u64,
        collateral_amount_ct: [u8; 32],
        collateral_price_ct: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(collateral_amount_ct)
            .encrypted_u64(collateral_price_ct)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![DepositCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "deposit")]
    pub fn deposit_callback(
        ctx: Context<DepositCallback>,
        output: SignedComputationOutputs<DepositOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(DepositOutput { field_0 }) => {
                let pos = &mut ctx.accounts.position;
                pos.collateral_amount_ct = field_0.ciphertexts[0];
                pos.collateral_price_ct = field_0.ciphertexts[1];
                pos.nonce = field_0.nonce.to_le_bytes();
                pos.is_active = true;
                emit!(DepositEvent {
                    owner: ctx.accounts.position.owner,
                });
            }
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        }
        Ok(())
    }

    // ─── Borrow ───────────────────────────────────────────────────────────────
    // BorrowData: { collateral_amount: u64, borrow_amount: u64 }
    // Plaintext inputs: new_borrow, asset_price

    pub fn borrow(
        ctx: Context<Borrow>,
        computation_offset: u64,
        collateral_amount_ct: [u8; 32],
        borrow_amount_ct: [u8; 32],
        new_borrow: u64,
        asset_price: u64,
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(collateral_amount_ct)
            .encrypted_u64(borrow_amount_ct)
            .plaintext_u64(new_borrow)
            .plaintext_u64(asset_price)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![BorrowCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "borrow")]
    pub fn borrow_callback(
        ctx: Context<BorrowCallback>,
        output: SignedComputationOutputs<BorrowOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(BorrowOutput { field_0 }) => {
                let approved: bool = field_0.field_0;
                let pos = &mut ctx.accounts.position;
                if approved {
                    pos.collateral_amount_ct = field_0.field_1.ciphertexts[0];
                    pos.borrow_amount_ct = field_0.field_1.ciphertexts[1];
                    pos.nonce = field_0.field_1.nonce.to_le_bytes();
                }
                emit!(BorrowEvent {
                    owner: ctx.accounts.position.owner,
                    approved,
                });
            }
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        }
        Ok(())
    }

    // ─── Compute Health Factor ────────────────────────────────────────────────
    // HealthData: { collateral_amount: u64, borrow_amount: u64, interest_accrued: u64 }
    // Returns Enc<Shared, (u64, u64)> = (collateral_scaled, total_debt)
    // Client decrypts both and computes: health = collateral_scaled / total_debt

    pub fn compute_health_factor(
        ctx: Context<ComputeHealthFactor>,
        computation_offset: u64,
        collateral_amount_ct: [u8; 32],
        borrow_amount_ct: [u8; 32],
        interest_accrued_ct: [u8; 32],
        current_price: u64,
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(collateral_amount_ct)
            .encrypted_u64(borrow_amount_ct)
            .encrypted_u64(interest_accrued_ct)
            .plaintext_u64(current_price)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeHealthFactorCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_health_factor")]
    pub fn compute_health_factor_callback(
        ctx: Context<ComputeHealthFactorCallback>,
        output: SignedComputationOutputs<ComputeHealthFactorOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeHealthFactorOutput { field_0 }) => {
                emit!(HealthFactorEvent {
                    owner: ctx.accounts.position.owner,
                    encrypted_collateral_scaled: field_0.ciphertexts[0],
                    encrypted_total_debt: field_0.ciphertexts[1],
                    nonce: field_0.nonce.to_le_bytes(),
                });
            }
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        }
        Ok(())
    }

    // ─── Check Liquidatable ───────────────────────────────────────────────────
    // HealthData: same 3-field struct
    // Returns revealed bool only

    pub fn check_liquidatable(
        ctx: Context<CheckLiquidatable>,
        computation_offset: u64,
        collateral_amount_ct: [u8; 32],
        borrow_amount_ct: [u8; 32],
        interest_accrued_ct: [u8; 32],
        current_price: u64,
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(collateral_amount_ct)
            .encrypted_u64(borrow_amount_ct)
            .encrypted_u64(interest_accrued_ct)
            .plaintext_u64(current_price)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CheckLiquidatableCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "check_liquidatable")]
    pub fn check_liquidatable_callback(
        ctx: Context<CheckLiquidatableCallback>,
        output: SignedComputationOutputs<CheckLiquidatableOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(CheckLiquidatableOutput { field_0 }) => {
                emit!(LiquidatableEvent {
                    owner: ctx.accounts.position.owner,
                    is_liquidatable: field_0,
                });
            }
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        }
        Ok(())
    }

    // ─── Accrue Interest ──────────────────────────────────────────────────────
    // InterestData: { borrow_amount: u64, interest_accrued: u64 }
    // interest_increment pre-computed client-side: borrow * rate_bps * time / 315_360_000_000

    pub fn accrue_interest(
        ctx: Context<AccrueInterest>,
        computation_offset: u64,
        borrow_amount_ct: [u8; 32],
        interest_accrued_ct: [u8; 32],
        interest_increment: u64,
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u64(borrow_amount_ct)
            .encrypted_u64(interest_accrued_ct)
            .plaintext_u64(interest_increment)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AccrueInterestCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "accrue_interest")]
    pub fn accrue_interest_callback(
        ctx: Context<AccrueInterestCallback>,
        output: SignedComputationOutputs<AccrueInterestOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(AccrueInterestOutput { field_0 }) => {
                let pos = &mut ctx.accounts.position;
                pos.borrow_amount_ct = field_0.ciphertexts[0];
                pos.interest_accrued_ct = field_0.ciphertexts[1];
                pos.nonce = field_0.nonce.to_le_bytes();
                emit!(InterestAccruedEvent {
                    owner: ctx.accounts.position.owner,
                });
            }
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        }
        Ok(())
    }
}

// ─── Position Account ─────────────────────────────────────────────────────────

#[account]
pub struct PositionAccount {
    pub owner: Pubkey,
    pub is_active: bool,
    pub collateral_amount_ct: [u8; 32],
    pub collateral_price_ct: [u8; 32],
    pub borrow_amount_ct: [u8; 32],
    pub interest_accrued_ct: [u8; 32],
    pub nonce: [u8; 16],
}

impl PositionAccount {
    // 8 disc + 32 owner + 1 is_active + 4*32 ciphertexts + 16 nonce
    pub const SIZE: usize = 8 + 32 + 1 + 32 * 4 + 16;
}

// ─── Account Structs ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreatePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = PositionAccount::SIZE,
        seeds = [b"position", owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
    pub system_program: Program<'info, System>,
}

// ── Deposit ───────────────────────────────────────────────────────────────────

#[queue_computation_accounts("deposit", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"position", payer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[callback_accounts("deposit")]
#[derive(Accounts)]
pub struct DepositCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"position", position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[init_computation_definition_accounts("deposit", payer)]
#[derive(Accounts)]
pub struct InitDepositCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Borrow ────────────────────────────────────────────────────────────────────

#[queue_computation_accounts("borrow", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_BORROW))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"position", payer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[callback_accounts("borrow")]
#[derive(Accounts)]
pub struct BorrowCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_BORROW))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"position", position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[init_computation_definition_accounts("borrow", payer)]
#[derive(Accounts)]
pub struct InitBorrowCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Compute Health Factor ─────────────────────────────────────────────────────

#[queue_computation_accounts("compute_health_factor", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ComputeHealthFactor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPUTE_HEALTH_FACTOR))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        seeds = [b"position", payer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[callback_accounts("compute_health_factor")]
#[derive(Accounts)]
pub struct ComputeHealthFactorCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPUTE_HEALTH_FACTOR))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        seeds = [b"position", position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[init_computation_definition_accounts("compute_health_factor", payer)]
#[derive(Accounts)]
pub struct InitComputeHealthFactorCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Check Liquidatable ────────────────────────────────────────────────────────

#[queue_computation_accounts("check_liquidatable", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CheckLiquidatable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CHECK_LIQUIDATABLE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        seeds = [b"position", payer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[callback_accounts("check_liquidatable")]
#[derive(Accounts)]
pub struct CheckLiquidatableCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CHECK_LIQUIDATABLE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        seeds = [b"position", position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[init_computation_definition_accounts("check_liquidatable", payer)]
#[derive(Accounts)]
pub struct InitCheckLiquidatableCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Accrue Interest ───────────────────────────────────────────────────────────

#[queue_computation_accounts("accrue_interest", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct AccrueInterest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ACCRUE_INTEREST))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"position", payer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[callback_accounts("accrue_interest")]
#[derive(Accounts)]
pub struct AccrueInterestCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ACCRUE_INTEREST))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"position", position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, PositionAccount>,
}

#[init_computation_definition_accounts("accrue_interest", payer)]
#[derive(Accounts)]
pub struct InitAccrueInterestCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct DepositEvent {
    pub owner: Pubkey,
}

#[event]
pub struct BorrowEvent {
    pub owner: Pubkey,
    pub approved: bool,
}

#[event]
pub struct HealthFactorEvent {
    pub owner: Pubkey,
    pub encrypted_collateral_scaled: [u8; 32],
    pub encrypted_total_debt: [u8; 32],
    pub nonce: [u8; 16],
}

#[event]
pub struct LiquidatableEvent {
    pub owner: Pubkey,
    pub is_liquidatable: bool,
}

#[event]
pub struct InterestAccruedEvent {
    pub owner: Pubkey,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
}
