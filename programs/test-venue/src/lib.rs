//! CrossFlow controlled residual venue — **synthetic test liquidity**, not a market.
//!
//! This program exists so that the demo's residual order is a real token transfer against a
//! frozen, published quote model instead of an animation. It is deliberately small: a pool PDA
//! holds one reserve per configured mint, and a swap is an exact-in pairwise constant-product
//! trade with a fixed fee. It is not an AMM, not a Meteora or Jupiter integration, and its
//! reserves are seeded with test tokens only.
//!
//! Safety properties the CrossFlow adapter depends on:
//! - the pool address and its three vaults are derived, never caller-chosen;
//! - the swap signer (CrossFlow's batch PDA) can only receive output into its own canonical
//!   associated token account for the output mint, and can only spend from its own canonical
//!   account for the input mint, so a venue can never redirect funds elsewhere;
//! - the measured output is whatever the transfers actually moved, and a shortfall below
//!   `min_out` reverts the whole transaction.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("Bq1FxNWHnmnZgJRi6fsRKrvLTbBf6uDTXjaawzdnkw1Q");

pub const MAX_FEE_BPS: u16 = 300;

#[program]
pub mod test_venue {
    use super::*;

    /// One-time pool creation. Reserves are the pool vault balances; the operator seeds them
    /// with test tokens before the first swap.
    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, VenueError::Fee);
        let mints = [ctx.accounts.mint0.key(), ctx.accounts.mint1.key(), ctx.accounts.mint2.key()];
        require!(mints[0] < mints[1] && mints[1] < mints[2], VenueError::Mints);
        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.fee_bps = fee_bps;
        pool.mints = mints;
        emit!(PoolInitialized { pool: pool.key(), mints, fee_bps });
        Ok(())
    }

    /// Exact-in swap between two reserves. `input_index`/`output_index` are validated against the
    /// stored mint order, so a caller cannot relabel which asset moved.
    pub fn swap(ctx: Context<Swap>, input_index: u8, output_index: u8, amount_in: u64, min_out: u64) -> Result<()> {
        let input = input_index as usize;
        let output = output_index as usize;
        require!(input < 3 && output < 3 && input != output, VenueError::Direction);
        require!(amount_in > 0, VenueError::Amount);
        let pool_key = ctx.accounts.pool.key();
        require!(ctx.accounts.mint_in.key() == ctx.accounts.pool.mints[input]
            && ctx.accounts.mint_out.key() == ctx.accounts.pool.mints[output], VenueError::Mints);
        require!(
            ctx.accounts.vault_in.key() == associated(&pool_key, ctx.accounts.mint_in.key())
                && ctx.accounts.vault_out.key() == associated(&pool_key, ctx.accounts.mint_out.key())
                && ctx.accounts.source.key() == associated(&ctx.accounts.authority.key(), ctx.accounts.mint_in.key())
                && ctx.accounts.destination.key() == associated(&ctx.accounts.authority.key(), ctx.accounts.mint_out.key()),
            VenueError::Vault
        );

        // Reserves are the measured vault balances, never a separately stored number that could
        // drift from the tokens the venue actually holds.
        let reserve_in = ctx.accounts.vault_in.amount;
        let reserve_out = ctx.accounts.vault_out.amount;
        require!(reserve_in > 0 && reserve_out > 0, VenueError::Reserves);
        let amount_out = quote(reserve_in, reserve_out, amount_in, ctx.accounts.pool.fee_bps)?;
        require!(amount_out > 0 && amount_out >= min_out, VenueError::MinOut);
        require!(amount_out < reserve_out, VenueError::Reserves);

        let decimals_in = ctx.accounts.mint_in.decimals;
        let decimals_out = ctx.accounts.mint_out.decimals;
        let source_info = ctx.accounts.source.to_account_info();
        let destination_info = ctx.accounts.destination.to_account_info();
        let vault_in_info = ctx.accounts.vault_in.to_account_info();
        let vault_out_info = ctx.accounts.vault_out.to_account_info();
        let source_before = raw_amount(&source_info)?;
        let destination_before = raw_amount(&destination_info)?;
        require!(source_before >= amount_in, VenueError::Amount);

        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.mint_in.to_account_info(),
                to: ctx.accounts.vault_in.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            }),
            amount_in,
            decimals_in,
        )?;
        let pool = &ctx.accounts.pool;
        let seeds: &[&[u8]] = &[b"pool", pool.mints[0].as_ref(), pool.mints[1].as_ref(), pool.mints[2].as_ref(), &[pool.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.vault_out.to_account_info(),
                mint: ctx.accounts.mint_out.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: pool.to_account_info(),
            }, &[seeds]),
            amount_out,
            decimals_out,
        )?;

        require!(
            raw_amount(&source_info)? == source_before - amount_in
                && raw_amount(&destination_info)? == destination_before.checked_add(amount_out).ok_or(VenueError::Arithmetic)?
                && raw_amount(&vault_in_info)? == reserve_in.checked_add(amount_in).ok_or(VenueError::Arithmetic)?
                && raw_amount(&vault_out_info)? == reserve_out - amount_out,
            VenueError::Delta
        );
        emit!(Swapped { pool: ctx.accounts.pool.key(), input: input_index, output: output_index, amount_in, amount_out,
            reserve_in: reserve_in.checked_add(amount_in).ok_or(VenueError::Arithmetic)?, reserve_out: reserve_out - amount_out });
        Ok(())
    }
}

/// Anchor caches a deserialized token account, so any post-CPI comparison must re-read the
/// account data rather than the stale cached field.
fn raw_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    require!(data.len() == 165, VenueError::Vault);
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(bytes))
}

fn associated(owner: &Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token::ID.as_ref(), mint.as_ref()], &anchor_spl::associated_token::ID).0
}

/// Exact-in constant product with a fee charged on the input, rounded down.
pub fn quote(reserve_in: u64, reserve_out: u64, amount_in: u64, fee_bps: u16) -> Result<u64> {
    let net = (amount_in as u128)
        .checked_mul((10_000 - fee_bps as u128) as u128)
        .ok_or(VenueError::Arithmetic)?;
    let numerator = (reserve_out as u128).checked_mul(net).ok_or(VenueError::Arithmetic)?;
    let denominator = (reserve_in as u128)
        .checked_mul(10_000)
        .and_then(|value| value.checked_add(net))
        .ok_or(VenueError::Arithmetic)?;
    u64::try_from(numerator / denominator).map_err(|_| error!(VenueError::Arithmetic))
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(init, payer=operator, space=Pool::SPACE,
        seeds=[b"pool",mint0.key().as_ref(),mint1.key().as_ref(),mint2.key().as_ref()],bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// CrossFlow's batch PDA, made a signer through the caller's `invoke_signed`.
    pub authority: Signer<'info>,
    #[account(mut, seeds=[b"pool",pool.mints[0].as_ref(),pool.mints[1].as_ref(),pool.mints[2].as_ref()],bump=pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub mint_in: Box<Account<'info, Mint>>,
    pub mint_out: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub source: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub destination: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_in: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_out: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub bump: u8,
    pub fee_bps: u16,
    pub mints: [Pubkey; 3],
}
impl Pool {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;
}

#[event]
pub struct PoolInitialized { pub pool: Pubkey, pub mints: [Pubkey; 3], pub fee_bps: u16 }
#[event]
pub struct Swapped { pub pool: Pubkey, pub input: u8, pub output: u8, pub amount_in: u64, pub amount_out: u64, pub reserve_in: u64, pub reserve_out: u64 }

#[error_code]
pub enum VenueError {
    #[msg("Fee exceeds the published venue maximum")]
    Fee,
    #[msg("Pool mint identity is invalid or unsorted")]
    Mints,
    #[msg("Swap direction must name two distinct configured reserves")]
    Direction,
    #[msg("Amount is zero or exceeds the caller's balance")]
    Amount,
    #[msg("Pool vault identity or caller account is not the derived canonical account")]
    Vault,
    #[msg("A reserve is empty; the operator must seed test liquidity")]
    Reserves,
    #[msg("Measured output is below the caller's minimum or nonpositive")]
    MinOut,
    #[msg("Measured vault deltas do not match the quoted swap")]
    Delta,
    #[msg("Checked arithmetic failed")]
    Arithmetic,
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn quote_charges_the_fee_on_the_input_and_never_exceeds_the_reserve() {
        // 100 in against a 10_000/10_000 pool: 98 with a 30 bps fee, 99 with none.
        assert_eq!(quote(10_000, 10_000, 100, 30).unwrap(), 98);
        assert_eq!(quote(10_000, 10_000, 100, 0).unwrap(), 99);
        assert_eq!(quote(1_000_000, 2_000_000, 1_000, 30).unwrap(), 1992);
        // One raw unit in can round to nothing, which the handler rejects as a zero output.
        assert_eq!(quote(1_000_000_000, 1_000, 1, 30).unwrap(), 0);
        assert_eq!(quote(u64::MAX / 2, u64::MAX / 2, 1, 30).unwrap(), 0);
    }
}
