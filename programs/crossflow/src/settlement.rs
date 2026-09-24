use crate::config::Config;
use crate::funding::{read_token, validate_mint_policy, FundingError};
use crate::intent::{Intent, IntentStatus, OwnerState, ThinSettleRequest};
use crate::oracle::{self, FixtureSnapshot};
use anchor_lang::prelude::*;
use anchor_spl::associated_token;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct SettleThin<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds=[b"owner",config.key().as_ref(),owner.key().as_ref()],bump=owner_state.bump)]
    pub owner_state: Box<Account<'info, OwnerState>>,
    #[account(mut, seeds=[b"intent",config.key().as_ref(),owner.key().as_ref(),intent.nonce.to_le_bytes().as_ref()],bump=intent.bump)]
    pub intent: Box<Account<'info, Intent>>,
    pub prices: Box<Account<'info, FixtureSnapshot>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    /// CHECK: exact intent ATA and token account state are checked before/after CPI.
    #[account(mut)]
    pub vault0: UncheckedAccount<'info>,
    /// CHECK: exact intent ATA and token account state are checked before/after CPI.
    #[account(mut)]
    pub vault1: UncheckedAccount<'info>,
    /// CHECK: exact intent ATA and token account state are checked before/after CPI.
    #[account(mut)]
    pub vault2: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint=mint0, associated_token::authority=owner)]
    pub recipient0: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=mint1, associated_token::authority=owner)]
    pub recipient1: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint=mint2, associated_token::authority=owner)]
    pub recipient2: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: exact sysvar ID is constrained.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

fn within_settlement_window(now: i64, expiry_unix_seconds: u64) -> bool {
    u64::try_from(now).is_ok_and(|now| now < expiry_unix_seconds)
}

pub fn settle_thin(ctx: Context<SettleThin>, request: ThinSettleRequest) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let policy = ctx.accounts.config.validate(config_key)?;
    require!(!ctx.accounts.config.settlement_paused, FundingError::Paused);
    require!(ctx.accounts.owner.key().is_on_curve(), FundingError::Owner);
    let owner = ctx.accounts.owner.key();
    let intent_key = ctx.accounts.intent.key();
    let intent = &ctx.accounts.intent;
    let state = &ctx.accounts.owner_state;
    let now = Clock::get()?.unix_timestamp;
    require!(intent.config == config_key && intent.owner == owner, SettlementError::Settle);
    require!(intent.status == IntentStatus::Funded, SettlementError::Settle);
    require!(within_settlement_window(now, intent.expiry_unix_seconds), SettlementError::Settle);
    require!(state.config == config_key && state.owner == owner && state.active_intent == Some(intent_key), SettlementError::Settle);
    require!(ctx.accounts.prices.sequence == request.expected_snapshot_sequence, SettlementError::SnapshotSequence);
    let price_guard = oracle::read_fixture(
        &ctx.accounts.prices.to_account_info(),
        &policy.binding(ctx.accounts.config.policy_hash),
        ctx.accounts.config.policy_hash,
        request.expected_snapshot_sequence,
        now,
    )?;
    price_guard.check_funding_reference(intent.assets.map(|asset| asset.funding_reference_price))?;

    let mints = [
        &ctx.accounts.mint0,
        &ctx.accounts.mint1,
        &ctx.accounts.mint2,
    ];
    let vaults = [
        ctx.accounts.vault0.to_account_info(),
        ctx.accounts.vault1.to_account_info(),
        ctx.accounts.vault2.to_account_info(),
    ];
    let recipients = [
        ctx.accounts.recipient0.to_account_info(),
        ctx.accounts.recipient1.to_account_info(),
        ctx.accounts.recipient2.to_account_info(),
    ];
    let mut vault_before = [0u64; 3];
    let mut recipient_before = [0u64; 3];
    for i in 0..3 {
        let mint = mints[i];
        let asset = policy.assets[i];
        validate_mint_policy(
            mint.key(), *mint.to_account_info().owner, mint.to_account_info().data_len(), mint.is_initialized,
            mint.decimals, mint.mint_authority.is_none(), mint.freeze_authority.is_none(), &asset,
        )?;
        let (expected_vault, _) = Pubkey::find_program_address(
            &[intent_key.as_ref(), token::ID.as_ref(), mint.key().as_ref()],
            &associated_token::ID,
        );
        require!(*vaults[i].key == expected_vault && *recipients[i].key == intent.recipients[i], FundingError::TokenIdentity);
        let vault = read_token(&vaults[i], intent_key, asset.mint)?;
        let recipient = read_token(&recipients[i], owner, asset.mint)?;
        require!(intent.booked_claims[i] == intent.assets[i].funding && vault.amount >= intent.booked_claims[i], SettlementError::Settle);
        vault_before[i] = vault.amount;
        recipient_before[i] = recipient.amount;
    }

    // The T06 thin path has no solver or asset conversion: it can return exactly the booked
    // per-asset funding amount. Bounds are checked immediately before each leg so a final-leg
    // rejection proves that earlier successful CPIs roll back atomically.
    let nonce = intent.nonce.to_le_bytes();
    let bump = [intent.bump];
    let signer_seeds: &[&[u8]] = &[b"intent", config_key.as_ref(), owner.as_ref(), nonce.as_ref(), &bump];
    for i in 0..3 {
        let output = request.final_outputs[i];
        let asset = intent.assets[i];
        require!(output >= asset.min_output && output <= asset.max_output, SettlementError::Output);
        require!(output == asset.funding && output == intent.booked_claims[i], SettlementError::Settle);
        if output > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: vaults[i].clone(),
                        mint: mints[i].to_account_info(),
                        to: recipients[i].clone(),
                        authority: ctx.accounts.intent.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                output,
                policy.assets[i].decimals,
            )?;
        }
        let vault_after = read_token(&vaults[i], intent_key, policy.assets[i].mint)?;
        let recipient_after = read_token(&recipients[i], owner, policy.assets[i].mint)?;
        require!(vault_after.amount == vault_before[i] - output && recipient_after.amount == recipient_before[i] + output, FundingError::Delta);
    }
    let intent = &mut ctx.accounts.intent;
    intent.booked_claims = [0; 3];
    intent.status = IntentStatus::Settled;
    emit!(ThinIntentSettled {
        intent: intent_key,
        owner,
        nonce: intent.nonce,
        mandate_hash: intent.mandate_hash,
        snapshot_sequence: request.expected_snapshot_sequence,
        outputs: request.final_outputs,
        initial_surplus: intent.initial_surplus,
    });
    Ok(())
}

#[event]
pub struct ThinIntentSettled {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub mandate_hash: [u8; 32],
    pub snapshot_sequence: u64,
    pub outputs: [u64; 3],
    pub initial_surplus: [u64; 3],
}

pub use crate::CrossflowError as SettlementError;

#[cfg(test)]
mod tests {
    use super::within_settlement_window;

    #[test]
    fn expiry_is_strict_before_at_and_after() {
        assert!(within_settlement_window(999, 1000));
        assert!(!within_settlement_window(1000, 1000));
        assert!(!within_settlement_window(1001, 1000));
        assert!(!within_settlement_window(-1, 1000));
    }
}
