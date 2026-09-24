use crate::config::Config;
use crate::funding::{read_token, validate_mint_policy, FundingError};
use crate::intent::{Intent, IntentStatus, OwnerState};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, CloseAccount, Mint, Token, TransferChecked};

#[derive(Accounts)]
pub struct CancelIntent<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"owner",config.key().as_ref(),owner.key().as_ref()],bump=owner_state.bump)]
    pub owner_state: Box<Account<'info, OwnerState>>,
    #[account(mut, seeds=[b"intent",config.key().as_ref(),owner.key().as_ref(),intent.nonce.to_le_bytes().as_ref()],bump=intent.bump)]
    pub intent: Box<Account<'info, Intent>>,
}

pub fn cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
    ctx.accounts.config.validate(ctx.accounts.config.key())?;
    let owner = ctx.accounts.owner.key();
    let intent = &mut ctx.accounts.intent;
    require!(intent.config == ctx.accounts.config.key() && intent.owner == owner, RecoveryError::RecoveryAuthority);
    require!(ctx.accounts.owner_state.config == ctx.accounts.config.key() &&
        ctx.accounts.owner_state.owner == owner && ctx.accounts.owner_state.active_intent == Some(intent.key()), RecoveryError::RecoveryAuthority);
    require!(intent.status == IntentStatus::Funded, RecoveryError::RecoveryStatus);
    intent.status = IntentStatus::Cancelled;
    // Cancellation is deliberately transfer-independent. Every vault claim remains available
    // for an owner-authorized, per-asset withdrawal.
    emit!(IntentCancelled { intent: intent.key(), owner, nonce: intent.nonce, mandate_hash: intent.mandate_hash });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawAsset<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"owner",config.key().as_ref(),owner.key().as_ref()],bump=owner_state.bump)]
    pub owner_state: Box<Account<'info, OwnerState>>,
    #[account(mut, seeds=[b"intent",config.key().as_ref(),owner.key().as_ref(),intent.nonce.to_le_bytes().as_ref()],bump=intent.bump)]
    pub intent: Box<Account<'info, Intent>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    /// CHECK: exact intent ATA and token state are checked by the handler.
    #[account(mut)]
    pub vault0: UncheckedAccount<'info>,
    /// CHECK: exact intent ATA and token state are checked by the handler.
    #[account(mut)]
    pub vault1: UncheckedAccount<'info>,
    /// CHECK: exact intent ATA and token state are checked by the handler.
    #[account(mut)]
    pub vault2: UncheckedAccount<'info>,
    /// CHECK: only the selected canonical owner ATA is created/decoded by the handler.
    #[account(mut)]
    pub recipient0: UncheckedAccount<'info>,
    /// CHECK: only the selected canonical owner ATA is created/decoded by the handler.
    #[account(mut)]
    pub recipient1: UncheckedAccount<'info>,
    /// CHECK: only the selected canonical owner ATA is created/decoded by the handler.
    #[account(mut)]
    pub recipient2: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn withdraw_asset(ctx: Context<WithdrawAsset>, asset_index: u8) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let policy = ctx.accounts.config.validate(config_key)?;
    let owner = ctx.accounts.owner.key();
    let intent_key = ctx.accounts.intent.key();
    require!(asset_index < 3, RecoveryError::RecoveryStatus);
    let i = asset_index as usize;
    let intent = &ctx.accounts.intent;
    let state = &ctx.accounts.owner_state;
    require!(intent.config == config_key && intent.owner == owner && state.config == config_key &&
        state.owner == owner && state.active_intent == Some(intent_key), RecoveryError::RecoveryAuthority);
    require!(matches!(intent.status, IntentStatus::Cancelled | IntentStatus::Settled), RecoveryError::RecoveryStatus);
    if intent.status == IntentStatus::Settled {
        require!(intent.booked_claims[i] == 0, RecoveryError::ClaimsRemain);
    }
    let mints = [&ctx.accounts.mint0, &ctx.accounts.mint1, &ctx.accounts.mint2];
    let vaults = [ctx.accounts.vault0.to_account_info(), ctx.accounts.vault1.to_account_info(), ctx.accounts.vault2.to_account_info()];
    let recipients = [ctx.accounts.recipient0.to_account_info(), ctx.accounts.recipient1.to_account_info(), ctx.accounts.recipient2.to_account_info()];
    validate_mint_policy(mints[i].key(), mints[i].to_account_info().data_len(), mints[i].is_initialized,
        mints[i].decimals, mints[i].mint_authority.is_none(), mints[i].freeze_authority.is_none(), &policy.assets[i])?;
    let (expected_vault, _) = Pubkey::find_program_address(
        &[intent_key.as_ref(), token::ID.as_ref(), mints[i].key().as_ref()], &associated_token::ID);
    let (expected_recipient, _) = Pubkey::find_program_address(
        &[owner.as_ref(), token::ID.as_ref(), mints[i].key().as_ref()], &associated_token::ID);
    require!(*vaults[i].key == expected_vault && *recipients[i].key == expected_recipient
        && intent.recipients[i] == expected_recipient, FundingError::TokenIdentity);
    let vault_before = read_token(&vaults[i], intent_key, policy.assets[i].mint)?;
    require!(vault_before.amount > 0, RecoveryError::NothingToWithdraw);
    associated_token::create_idempotent(CpiContext::new(
        ctx.accounts.associated_token_program.key(),
        Create {
            payer: ctx.accounts.owner.to_account_info(),
            associated_token: recipients[i].clone(),
            authority: ctx.accounts.owner.to_account_info(),
            mint: mints[i].to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
    ))?;
    let recipient_before = read_token(&recipients[i], owner, policy.assets[i].mint)?;
    let amount = vault_before.amount;
    let nonce = intent.nonce.to_le_bytes();
    let bump = [intent.bump];
    let signer_seeds: &[&[u8]] = &[b"intent", config_key.as_ref(), owner.as_ref(), nonce.as_ref(), &bump];
    if amount > 0 {
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: vaults[i].clone(), mint: mints[i].to_account_info(), to: recipients[i].clone(),
                authority: ctx.accounts.intent.to_account_info(),
            }, &[signer_seeds]),
            amount, policy.assets[i].decimals,
        )?;
    }
    let vault_after = read_token(&vaults[i], intent_key, policy.assets[i].mint)?;
    let recipient_after = read_token(&recipients[i], owner, policy.assets[i].mint)?;
    require!(vault_after.amount == 0 && recipient_after.amount == recipient_before.amount.checked_add(amount).ok_or(FundingError::Delta)?, FundingError::Delta);
    let intent = &mut ctx.accounts.intent;
    intent.booked_claims[i] = 0;
    intent.initial_surplus[i] = 0;
    emit!(AssetWithdrawn { intent: intent_key, owner, asset_index, amount, status: intent.status as u8 });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseIntent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds=[b"owner",config.key().as_ref(),owner.key().as_ref()],bump=owner_state.bump)]
    pub owner_state: Box<Account<'info, OwnerState>>,
    #[account(mut, close=owner, seeds=[b"intent",config.key().as_ref(),owner.key().as_ref(),intent.nonce.to_le_bytes().as_ref()],bump=intent.bump)]
    pub intent: Box<Account<'info, Intent>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    /// CHECK: exact intent ATA and empty token state are checked by the handler.
    #[account(mut)]
    pub vault0: UncheckedAccount<'info>,
    /// CHECK: exact intent ATA and empty token state are checked by the handler.
    #[account(mut)]
    pub vault1: UncheckedAccount<'info>,
    /// CHECK: exact intent ATA and empty token state are checked by the handler.
    #[account(mut)]
    pub vault2: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn close_intent(ctx: Context<CloseIntent>) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let policy = ctx.accounts.config.validate(config_key)?;
    let owner = ctx.accounts.owner.key();
    let intent_key = ctx.accounts.intent.key();
    let intent = &ctx.accounts.intent;
    require!(intent.config == config_key && intent.owner == owner &&
        ctx.accounts.owner_state.config == config_key && ctx.accounts.owner_state.owner == owner &&
        ctx.accounts.owner_state.active_intent == Some(intent_key), RecoveryError::RecoveryAuthority);
    require!(matches!(intent.status, IntentStatus::Cancelled | IntentStatus::Settled), RecoveryError::RecoveryStatus);
    require!(intent.booked_claims == [0; 3], RecoveryError::ClaimsRemain);
    let mints = [&ctx.accounts.mint0, &ctx.accounts.mint1, &ctx.accounts.mint2];
    let vaults = [ctx.accounts.vault0.to_account_info(), ctx.accounts.vault1.to_account_info(), ctx.accounts.vault2.to_account_info()];
    for i in 0..3 {
        validate_mint_policy(mints[i].key(), mints[i].to_account_info().data_len(), mints[i].is_initialized,
            mints[i].decimals, mints[i].mint_authority.is_none(), mints[i].freeze_authority.is_none(), &policy.assets[i])?;
        let (expected_vault, _) = Pubkey::find_program_address(
            &[intent_key.as_ref(), token::ID.as_ref(), mints[i].key().as_ref()], &associated_token::ID);
        require!(*vaults[i].key == expected_vault, FundingError::TokenIdentity);
        let vault = read_token(&vaults[i], intent_key, policy.assets[i].mint)?;
        require!(vault.amount == 0 && intent.initial_surplus[i] == 0, RecoveryError::ClaimsRemain);
    }
    let nonce = intent.nonce.to_le_bytes();
    let bump = [intent.bump];
    let signer_seeds: &[&[u8]] = &[b"intent", config_key.as_ref(), owner.as_ref(), nonce.as_ref(), &bump];
    for vault in vaults {
        token::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(), CloseAccount {
            account: vault, destination: ctx.accounts.owner.to_account_info(), authority: ctx.accounts.intent.to_account_info(),
        }, &[signer_seeds]))?;
    }
    let outstanding = ctx.accounts.config.outstanding_claim_intents.checked_sub(1).ok_or(RecoveryError::ClaimsRemain)?;
    ctx.accounts.config.outstanding_claim_intents = outstanding;
    ctx.accounts.owner_state.active_intent = None;
    emit!(IntentClosed { intent: intent_key, owner, nonce: ctx.accounts.intent.nonce });
    Ok(())
}

#[event]
pub struct IntentCancelled { pub intent: Pubkey, pub owner: Pubkey, pub nonce: u64, pub mandate_hash: [u8; 32] }
#[event]
pub struct AssetWithdrawn { pub intent: Pubkey, pub owner: Pubkey, pub asset_index: u8, pub amount: u64, pub status: u8 }
#[event]
pub struct IntentClosed { pub intent: Pubkey, pub owner: Pubkey, pub nonce: u64 }

pub use crate::CrossflowError as RecoveryError;
