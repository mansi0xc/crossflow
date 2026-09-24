use crate::config::Config;
pub(crate) use crate::assets::validate_mint_policy;
use crate::intent::{FundRequest, Intent, IntentError, IntentStatus, OwnerState};
use crate::oracle::{self, FixtureSnapshot};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::spl_token::state::AccountState;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
#[instruction(request:FundRequest)]
pub struct CreateAndFund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init_if_needed,payer=owner,space=OwnerState::SPACE,
        seeds=[b"owner",config.key().as_ref(),owner.key().as_ref()],bump)]
    pub owner_state: Box<Account<'info, OwnerState>>,
    #[account(init,payer=owner,space=Intent::SPACE,
        seeds=[b"intent",config.key().as_ref(),owner.key().as_ref(),request.nonce.to_le_bytes().as_ref()],bump)]
    pub intent: Box<Account<'info, Intent>>,
    pub prices: Box<Account<'info, FixtureSnapshot>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    #[account(mut,associated_token::mint=mint0,associated_token::authority=owner)]
    pub source0: Box<Account<'info, TokenAccount>>,
    #[account(mut,associated_token::mint=mint1,associated_token::authority=owner)]
    pub source1: Box<Account<'info, TokenAccount>>,
    #[account(mut,associated_token::mint=mint2,associated_token::authority=owner)]
    pub source2: Box<Account<'info, TokenAccount>>,
    /// CHECK: handler derives the exact intent ATA, creates it through the pinned ATA program,
    /// then validates token program, mint, authority, state, delegates and actual balance deltas.
    #[account(mut)]
    pub vault0: UncheckedAccount<'info>,
    /// CHECK: handler derives the exact intent ATA, creates it through the pinned ATA program,
    /// then validates token program, mint, authority, state, delegates and actual balance deltas.
    #[account(mut)]
    pub vault1: UncheckedAccount<'info>,
    /// CHECK: handler derives the exact intent ATA, creates it through the pinned ATA program,
    /// then validates token program, mint, authority, state, delegates and actual balance deltas.
    #[account(mut)]
    pub vault2: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: exact sysvar ID is constrained; SDK checked loaders validate it again.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[inline(never)]
fn ensure_vault<'info>(
    payer: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    system: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[
            authority.key.as_ref(),
            token::ID.as_ref(),
            mint.key.as_ref(),
        ],
        &associated_token::ID,
    );
    require!(*vault.key == expected, FundingError::TokenIdentity);
    associated_token::create_idempotent(CpiContext::new(
        associated_token::ID,
        Create {
            payer,
            associated_token: vault,
            authority,
            mint,
            system_program: system,
            token_program,
        },
    ))
}

pub(crate) fn read_token(account: &AccountInfo, owner: Pubkey, mint: Pubkey) -> Result<TokenAccount> {
    require!(
        *account.owner == token::ID && !account.executable,
        FundingError::TokenIdentity
    );
    let data = account.try_borrow_data()?;
    require!(data.len() == 165, FundingError::TokenIdentity);
    let token = TokenAccount::try_deserialize(&mut &data[..])?;
    require!(
        token.owner == owner
            && token.mint == mint
            && token.state == AccountState::Initialized
            && token.delegate.is_none()
            && token.delegated_amount == 0
            && token.close_authority.is_none()
            && token.is_native.is_none(),
        FundingError::TokenState
    );
    Ok(token)
}

fn exact_funding_instruction(ctx: &Context<CreateAndFund>, request: &FundRequest) -> Result<()> {
    let info = ctx.accounts.instructions_sysvar.to_account_info();
    validate_funding_instruction(&info, request, get_stack_height())
}

fn validate_funding_instruction(
    info: &AccountInfo,
    request: &FundRequest,
    stack_height: usize,
) -> Result<()> {
    require!(
        stack_height == TRANSACTION_LEVEL_STACK_HEIGHT,
        FundingError::Instruction
    );
    let index = solana_instructions_sysvar::load_current_index_checked(info)?;
    let ix = solana_instructions_sysvar::load_instruction_at_checked(index as usize, info)?;
    let mut body = Vec::with_capacity(177);
    request.serialize(&mut body)?;
    require!(
        ix.program_id == crate::ID
            && body.len() == 177
            && ix.data.len() == 185
            && ix.data[..8] == *crate::instruction::CreateAndFund::DISCRIMINATOR
            && ix.data[8..] == body,
        FundingError::Instruction
    );
    Ok(())
}

pub fn create_and_fund(ctx: Context<CreateAndFund>, request: FundRequest) -> Result<()> {
    exact_funding_instruction(&ctx, &request)?;
    let cfg = &ctx.accounts.config;
    let policy = cfg.validate(cfg.key())?;
    require!(!cfg.funding_paused, FundingError::Paused);
    let owner = ctx.accounts.owner.key();
    let intent_address = ctx.accounts.intent.key();
    require!(owner.is_on_curve(), FundingError::Owner);
    let now = Clock::get()?.unix_timestamp;
    request.validate(cfg.policy_hash, now, policy.max_intent_lifetime)?;
    let price_guard = oracle::read_fixture(
        &ctx.accounts.prices.to_account_info(),
        &policy.binding(cfg.policy_hash),
        request.expected_policy_hash,
        ctx.accounts.prices.sequence,
        now,
    )?;
    price_guard.check_funding_reference(request.assets.map(|a| a.funding_reference_price))?;

    let state = &ctx.accounts.owner_state;
    if state.owner == Pubkey::default() {
        require!(
            state.config == Pubkey::default()
                && state.next_nonce == 0
                && state.active_intent.is_none()
                && state.bump == 0,
            IntentError::Nonce
        );
    } else {
        require!(
            state.owner == owner
                && state.config == cfg.key()
                && state.bump == ctx.bumps.owner_state,
            IntentError::Nonce
        );
    }
    require!(
        state.active_intent.is_none() && request.nonce == state.next_nonce,
        IntentError::Nonce
    );
    let next_nonce = request
        .nonce
        .checked_add(1)
        .ok_or(IntentError::Arithmetic)?;
    let next_claim_count = cfg
        .outstanding_claim_intents
        .checked_add(1)
        .ok_or(IntentError::Arithmetic)?;
    let mints = [
        &ctx.accounts.mint0,
        &ctx.accounts.mint1,
        &ctx.accounts.mint2,
    ];
    let sources = [
        ctx.accounts.source0.to_account_info(),
        ctx.accounts.source1.to_account_info(),
        ctx.accounts.source2.to_account_info(),
    ];
    let vaults = [
        ctx.accounts.vault0.to_account_info(),
        ctx.accounts.vault1.to_account_info(),
        ctx.accounts.vault2.to_account_info(),
    ];
    let mut identities = vec![
        owner,
        cfg.key(),
        state.key(),
        intent_address,
        ctx.accounts.prices.key(),
    ];
    for i in 0..3 {
        identities.extend([mints[i].key(), *sources[i].key, *vaults[i].key]);
    }
    for i in 0..identities.len() {
        for j in i + 1..identities.len() {
            require!(identities[i] != identities[j], FundingError::Alias);
        }
    }
    let mut source_before = [0; 3];
    let mut surplus = [0; 3];
    let mut expected_vault = [0; 3];
    for i in 0..3 {
        let asset = policy.assets[i];
        let mint = mints[i];
        validate_mint_policy(
            mint.key(), *mint.to_account_info().owner, mint.to_account_info().data_len(), mint.is_initialized,
            mint.decimals, mint.mint_authority.is_none(), mint.freeze_authority.is_none(), &asset,
        )?;
        let source = read_token(&sources[i], owner, asset.mint)?;
        ensure_vault(
            ctx.accounts.owner.to_account_info(),
            vaults[i].clone(),
            ctx.accounts.intent.to_account_info(),
            mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        )?;
        let vault = read_token(&vaults[i], intent_address, asset.mint)?;
        source_before[i] = source.amount;
        surplus[i] = vault.amount;
        require!(
            source.amount >= request.assets[i].funding,
            FundingError::InsufficientFunds
        );
        expected_vault[i] = vault
            .amount
            .checked_add(request.assets[i].funding)
            .ok_or(IntentError::Arithmetic)?;
    }
    for i in 0..3 {
        let amount = request.assets[i].funding;
        if amount > 0 {
            token::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: sources[i].clone(),
                        mint: mints[i].to_account_info(),
                        to: vaults[i].clone(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                amount,
                policy.assets[i].decimals,
            )?;
        }
    }
    for i in 0..3 {
        let source = read_token(&sources[i], owner, policy.assets[i].mint)?;
        let vault = read_token(&vaults[i], intent_address, policy.assets[i].mint)?;
        require!(
            source.amount == source_before[i] - request.assets[i].funding
                && vault.amount == expected_vault[i],
            FundingError::Delta
        );
    }
    let recipients = sources.map(|a| *a.key);
    let vault_addresses = vaults.map(|a| *a.key);
    let mandate_hash = request.mandate_hash(&policy, cfg.policy_hash, owner, recipients);
    let config_key = cfg.key();
    let policy_hash = cfg.policy_hash;
    ctx.accounts.intent.set_inner(Intent {
        config: config_key,
        owner,
        nonce: request.nonce,
        expiry_unix_seconds: request.expiry_unix_seconds,
        policy_hash,
        mandate_hash,
        optimization_commitment: request.optimization_commitment,
        assets: request.assets,
        recipients,
        vaults: vault_addresses,
        booked_claims: request.assets.map(|a| a.funding),
        initial_surplus: surplus,
        status: IntentStatus::Funded,
        bump: ctx.bumps.intent,
    });
    ctx.accounts.owner_state.set_inner(OwnerState {
        config: config_key,
        owner,
        next_nonce,
        active_intent: Some(intent_address),
        bump: ctx.bumps.owner_state,
    });
    ctx.accounts.config.outstanding_claim_intents = next_claim_count;
    emit!(IntentFunded {
        intent: intent_address,
        owner,
        nonce: request.nonce,
        mandate_hash,
        policy_hash,
        funding: request.assets.map(|a| a.funding),
        surplus
    });
    Ok(())
}

#[event]
pub struct IntentFunded {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub mandate_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub funding: [u64; 3],
    pub surplus: [u64; 3],
}

pub use crate::CrossflowError as FundingError;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::FundAsset;
    use anchor_lang::solana_program::instruction::BorrowedInstruction;
    use crate::config::AssetPolicy;

    #[test]
    fn mint_policy_rejects_identity_and_decimal_mismatch() {
        let key = Pubkey::new_from_array([3; 32]);
        let asset = AssetPolicy { mint: key, token_program: token::ID, decimals: 6, feed_id: [4; 32] };
        assert!(validate_mint_policy(key, token::ID, 82, true, 9, true, true, &asset).is_err());
        assert!(validate_mint_policy(Pubkey::new_from_array([5; 32]), token::ID, 82, true, 6, true, true, &asset).is_err());
        assert!(validate_mint_policy(key, token::ID, 82, true, 6, true, true, &asset).is_ok());
    }

    fn request() -> FundRequest {
        FundRequest {
            schema_version: 1,
            expected_policy_hash: [9; 32],
            nonce: 0,
            expiry_unix_seconds: 1001,
            optimization_commitment: [8; 32],
            assets: [FundAsset {
                funding: 1,
                min_output: 0,
                max_output: 2,
                funding_reference_price: 1,
            }; 3],
        }
    }
    fn check_instruction(
        trailing: bool,
        height: usize,
        wrong_program: bool,
        wrong_discriminator: bool,
        wrong_sysvar: bool,
    ) -> Result<()> {
        let r = request();
        let mut data = crate::instruction::CreateAndFund::DISCRIMINATOR.to_vec();
        r.serialize(&mut data).unwrap();
        if trailing {
            data.push(0);
        }
        if wrong_discriminator {
            data[0] ^= 1;
        }
        let program = if wrong_program {
            Pubkey::new_from_array([55; 32])
        } else {
            crate::ID
        };
        let ix = BorrowedInstruction {
            program_id: &program,
            accounts: vec![],
            data: &data,
        };
        let mut sysvar = solana_instructions_sysvar::construct_instructions_data(&[ix]);
        solana_instructions_sysvar::store_current_index_checked(&mut sysvar, 0).unwrap();
        let key = if wrong_sysvar {
            Pubkey::default()
        } else {
            solana_instructions_sysvar::ID
        };
        let mut lamports = 1;
        let owner = Pubkey::default();
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut sysvar,
            &owner,
            false,
        );
        validate_funding_instruction(&info, &r, height)
    }
    #[test]
    fn exact_top_level_funding_instruction_and_trailing_bytes() {
        assert!(check_instruction(false, 1, false, false, false).is_ok());
        assert!(check_instruction(true, 1, false, false, false).is_err());
        assert!(check_instruction(false, 1, false, true, false).is_err());
    }
    #[test]
    fn cpi_program_and_sysvar_substitution_rejected() {
        assert!(check_instruction(false, 2, false, false, false).is_err());
        assert!(check_instruction(false, 1, true, false, false).is_err());
        assert!(check_instruction(false, 1, false, false, true).is_err());
    }
}
