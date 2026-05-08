use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    #[derive(Copy, Clone)]
    pub struct DepositData {
        collateral_amount: u64,
        collateral_price: u64,
    }

    #[derive(Copy, Clone)]
    pub struct BorrowData {
        collateral_amount: u64,
        borrow_amount: u64,
    }

    #[derive(Copy, Clone)]
    pub struct HealthData {
        collateral_amount: u64,
        borrow_amount: u64,
        interest_accrued: u64,
    }

    #[derive(Copy, Clone)]
    pub struct InterestData {
        borrow_amount: u64,
        interest_accrued: u64,
    }

    // Circuit 1: Deposit
    #[instruction]
    pub fn deposit(
        data_ctxt: Enc<Shared, DepositData>,
    ) -> Enc<Shared, DepositData> {
        let data = data_ctxt.to_arcis();
        data_ctxt.owner.from_arcis(data)
    }

    // Circuit 2: Borrow — NO division
    // Approved if: (existing_borrow + new_borrow) * 100 <= collateral_amount * asset_price * 80
    #[instruction]
    pub fn borrow(
        data_ctxt: Enc<Shared, BorrowData>,
        new_borrow: u64,
        asset_price: u64,
    ) -> (bool, Enc<Shared, BorrowData>) {
        let mut data = data_ctxt.to_arcis();
        let total = data.borrow_amount + new_borrow;
        let lhs = total * 100;
        let rhs = data.collateral_amount * asset_price * 80;
        let approved = lhs <= rhs;
        if approved {
            data.borrow_amount = total;
        }
        (approved.reveal(), data_ctxt.owner.from_arcis(data))
    }

    // Circuit 3: Health factor — NO division
    // Returns encrypted (collateral_scaled, total_debt) pair
    // Client computes ratio off-chain: health = collateral_scaled / total_debt
    #[instruction]
    pub fn compute_health_factor(
        data_ctxt: Enc<Shared, HealthData>,
        current_price: u64,
    ) -> Enc<Shared, (u64, u64)> {
        let data = data_ctxt.to_arcis();
        let collateral_scaled = data.collateral_amount * current_price * 85;
        let total_debt = data.borrow_amount + data.interest_accrued;
        data_ctxt.owner.from_arcis((collateral_scaled, total_debt))
    }

    // Circuit 4: Liquidatable — NO division
    // Liquidatable if: total_debt * 100 > collateral_amount * price * 85
    #[instruction]
    pub fn check_liquidatable(
        data_ctxt: Enc<Shared, HealthData>,
        current_price: u64,
    ) -> bool {
        let data = data_ctxt.to_arcis();
        let lhs = (data.borrow_amount + data.interest_accrued) * 100;
        let rhs = data.collateral_amount * current_price * 85;
        let liquidatable = lhs > rhs;
        liquidatable.reveal()
    }

    // Circuit 5: Accrue interest — NO division
    // Client pre-computes: interest_increment = borrow * rate_bps * time_secs / 315_360_000_000
    // Only the increment is passed in as plaintext — circuit just adds it
    #[instruction]
    pub fn accrue_interest(
        data_ctxt: Enc<Shared, InterestData>,
        interest_increment: u64,
    ) -> Enc<Shared, InterestData> {
        let mut data = data_ctxt.to_arcis();
        data.interest_accrued = data.interest_accrued + interest_increment;
        data_ctxt.owner.from_arcis(data)
    }
}
