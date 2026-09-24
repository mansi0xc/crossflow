//! T09 bounded internal batch settlement.
//!
//! The instruction body is exactly the canonical T11 encoding
//! `[schema, batch_count, sequence u64, cross_count, crosses, residual_count, residuals]`.
//! T09 admits internal crossings only: every residual record is rejected because the committed
//! policy still has routing disabled. Authority comes exclusively from funded mandates. The
//! submitter signs nothing and can only move value inside already-approved raw bounds.
use crate::assets::validate_mint_policy;
use crate::config::Config;
use crate::funding::{read_token, FundingError};
use crate::intent::{Intent, IntentStatus, OwnerState};
use crate::math::{checked_add_amount, MAX_AMOUNT, MAX_POOL_AMOUNT};
use crate::oracle::{self, FixtureSnapshot};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_spl::associated_token;
use anchor_spl::token::{self, Mint, Token, TransferChecked};

pub const MAX_BATCH: usize = 3;
pub const MAX_CROSSES: usize = 6;
const ACCOUNTS_PER_INTENT: usize = 8;
pub const MAX_BATCH_BODY: usize = 194;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatchCross {
    pub stock_index: u8,
    pub seller_index: u8,
    pub buyer_index: u8,
    pub stock_quantity: u64,
    pub cash_amount: u64,
}

#[derive(Clone, Debug)]
pub struct BatchBody {
    pub batch_count: u8,
    pub expected_snapshot_sequence: u64,
    pub crosses: Vec<BatchCross>,
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or(SettlementError::Instruction)?;
    let mut array = [0u8; 8];
    array.copy_from_slice(slice);
    Ok(u64::from_le_bytes(array))
}

/// Canonical decode. Trailing bytes, an unknown schema, oversized records and any residual
/// record are rejected before any account or token state is touched.
pub fn decode_batch_body(bytes: &[u8]) -> Result<BatchBody> {
    require!(
        bytes.len() >= 12 && bytes.len() <= MAX_BATCH_BODY && bytes[0] == 1,
        SettlementError::Instruction
    );
    let batch_count = bytes[1];
    require!(
        (1..=MAX_BATCH as u8).contains(&batch_count),
        SettlementError::Instruction
    );
    let expected_snapshot_sequence = read_u64(bytes, 2)?;
    let mut cursor = 10usize;
    let cross_count = *bytes.get(cursor).ok_or(SettlementError::Instruction)? as usize;
    cursor += 1;
    require!(cross_count <= MAX_CROSSES, SettlementError::Instruction);
    let mut crosses = Vec::with_capacity(cross_count);
    for _ in 0..cross_count {
        let record = bytes
            .get(cursor..cursor + 19)
            .ok_or(SettlementError::Instruction)?;
        crosses.push(BatchCross {
            stock_index: record[0],
            seller_index: record[1],
            buyer_index: record[2],
            stock_quantity: read_u64(record, 3)?,
            cash_amount: read_u64(record, 11)?,
        });
        cursor += 19;
    }
    let residual_count = *bytes.get(cursor).ok_or(SettlementError::Instruction)? as usize;
    cursor += 1;
    // Residual records have a fixed width; parse them only to prove the body is canonical and
    // then reject, because the committed policy still has external routing disabled.
    for _ in 0..residual_count {
        let width = 10 + 8 * batch_count as usize;
        let _ = bytes
            .get(cursor..cursor + width)
            .ok_or(SettlementError::Instruction)?;
        cursor += width;
    }
    require!(
        cursor == bytes.len() && residual_count == 0,
        SettlementError::Instruction
    );
    Ok(BatchBody {
        batch_count,
        expected_snapshot_sequence,
        crosses,
    })
}

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    #[account(seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub prices: Box<Account<'info, FixtureSnapshot>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: exact sysvar ID is constrained; the handler authenticates the current instruction.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// The body is self-delimiting, so padding the raw instruction could otherwise be ignored.
/// Require the exact top-level instruction that T11 encodes, exactly as `create_and_fund` does.
#[inline(never)]
fn exact_batch_instruction(info: &AccountInfo, body_len: usize) -> Result<()> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        SettlementError::Instruction
    );
    let index = solana_instructions_sysvar::load_current_index_checked(info)?;
    let ix = solana_instructions_sysvar::load_instruction_at_checked(index as usize, info)?;
    require!(
        ix.program_id == crate::ID && ix.data.len() == 12 + body_len,
        SettlementError::Instruction
    );
    Ok(())
}

/// Deserializing a 520-byte intent or a 114-byte owner state inline would overflow the SBF
/// stack once combined with the policy and token-account locals, so each helper keeps its own
/// small frame and hands back a heap value.
#[inline(never)]
fn read_intent(info: &AccountInfo) -> Result<Box<Intent>> {
    require!(
        *info.owner == crate::ID && !info.executable && info.is_writable,
        SettlementError::BatchAccount
    );
    let data = info.try_borrow_data()?;
    let mut slice = &data[..];
    let value = Intent::try_deserialize(&mut slice).map_err(|_| error!(SettlementError::BatchAccount))?;
    Ok(Box::new(value))
}

#[inline(never)]
fn read_owner_state(info: &AccountInfo) -> Result<Box<OwnerState>> {
    require!(*info.owner == crate::ID && !info.executable, SettlementError::BatchAccount);
    let data = info.try_borrow_data()?;
    let mut slice = &data[..];
    let value = OwnerState::try_deserialize(&mut slice).map_err(|_| error!(SettlementError::BatchAccount))?;
    Ok(Box::new(value))
}

fn vault_for(intent: Pubkey, mint: Pubkey) -> Result<Pubkey> {
    Ok(Pubkey::find_program_address(
        &[intent.as_ref(), token::ID.as_ref(), mint.as_ref()],
        &associated_token::ID,
    )
    .0)
}

fn recipient_for(owner: Pubkey, mint: Pubkey) -> Result<Pubkey> {
    Ok(Pubkey::find_program_address(
        &[owner.as_ref(), token::ID.as_ref(), mint.as_ref()],
        &associated_token::ID,
    )
    .0)
}

pub fn settle_batch<'info>(
    ctx: Context<'info, SettleBatch<'info>>,
    body: Vec<u8>,
) -> Result<()> {
    exact_batch_instruction(&ctx.accounts.instructions_sysvar.to_account_info(), body.len())?;
    let parsed = decode_batch_body(&body)?;
    let batch_count = parsed.batch_count as usize;
    // A one-owner batch has no possible cross and would be a permissionless no-op state
    // transition. Single-owner settlement stays on the owner-signed `settle_thin` path, which
    // matches the off-chain validator, which only admits a marked technical probe.
    require!(batch_count >= 2, SettlementError::Settle);
    let config_key = ctx.accounts.config.key();
    let policy = ctx.accounts.config.validate(config_key)?;
    require!(!ctx.accounts.config.settlement_paused, FundingError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let price_guard = oracle::read_fixture(
        &ctx.accounts.prices.to_account_info(),
        &policy.binding(ctx.accounts.config.policy_hash),
        ctx.accounts.config.policy_hash,
        parsed.expected_snapshot_sequence,
        now,
    )?;

    let mints = [
        ctx.accounts.mint0.to_account_info(),
        ctx.accounts.mint1.to_account_info(),
        ctx.accounts.mint2.to_account_info(),
    ];
    let token_program = ctx.accounts.token_program.to_account_info();
    let accounts = ctx.remaining_accounts;
    require!(
        accounts.len() == batch_count * ACCOUNTS_PER_INTENT,
        SettlementError::BatchAccount
    );

    // Accumulators live on the heap: the SBF stack cannot hold several 3x3 matrices plus the
    // deserialized intent and token accounts in one frame.
    let mut intents: Vec<Box<Intent>> = Vec::with_capacity(batch_count);
    let mut owners: Vec<Pubkey> = Vec::with_capacity(batch_count);
    let mut funding: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut surplus: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut recipient_before: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut identities: Vec<Pubkey> = Vec::new();

    for i in 0..batch_count {
        let base = i * ACCOUNTS_PER_INTENT;
        let owner_state_info = &accounts[base];
        let intent_info = &accounts[base + 1];
        let intent = read_intent(intent_info)?;
        let owner_state = read_owner_state(owner_state_info)?;
        let owner = intent.owner;
        require!(owner.is_on_curve(), FundingError::Owner);
        require!(
            intent.config == config_key && owner_state.config == config_key,
            SettlementError::BatchAccount
        );
        require!(
            owner_state.owner == owner && owner_state.active_intent == Some(intent_info.key()),
            SettlementError::BatchAccount
        );
        require!(
            Pubkey::find_program_address(
                &[b"owner", config_key.as_ref(), owner.as_ref()],
                &crate::ID
            )
            .0 == owner_state_info.key()
                && Pubkey::find_program_address(
                    &[
                        b"intent",
                        config_key.as_ref(),
                        owner.as_ref(),
                        intent.nonce.to_le_bytes().as_ref()
                    ],
                    &crate::ID
                )
                .0 == intent_info.key(),
            SettlementError::BatchAccount
        );
        require!(
            intent.status == IntentStatus::Funded
                && u64::try_from(now).is_ok_and(|value| value < intent.expiry_unix_seconds),
            SettlementError::Settle
        );
        if i > 0 {
            require!(owners[i - 1] < owner, SettlementError::BatchAccount);
        }
        owners.push(owner);
        identities.push(owner_state_info.key());
        identities.push(intent_info.key());

        for a in 0..3 {
            let typed = match a {
                0 => &ctx.accounts.mint0,
                1 => &ctx.accounts.mint1,
                _ => &ctx.accounts.mint2,
            };
            validate_mint_policy(
                typed.key(),
                *typed.to_account_info().owner,
                typed.to_account_info().data_len(),
                typed.is_initialized,
                typed.decimals,
                typed.mint_authority.is_none(),
                typed.freeze_authority.is_none(),
                &policy.assets[a],
            )?;
            let vault_info = &accounts[base + 2 + a];
            let recipient_info = &accounts[base + 5 + a];
            require!(
                vault_info.is_writable && recipient_info.is_writable,
                SettlementError::BatchAccount
            );
            require!(
                vault_info.key() == vault_for(intent_info.key(), typed.key())?
                    && recipient_info.key() == recipient_for(owner, typed.key())?
                    && intent.vaults[a] == vault_info.key()
                    && intent.recipients[a] == recipient_info.key(),
                FundingError::TokenIdentity
            );
            let vault = read_token(vault_info, intent_info.key(), typed.key())?;
            let recipient = read_token(recipient_info, owner, typed.key())?;
            require!(
                intent.booked_claims[a] == intent.assets[a].funding
                    && vault.amount >= intent.booked_claims[a],
                SettlementError::Settle
            );
            require!(
                vault.amount <= MAX_POOL_AMOUNT && intent.assets[a].funding <= MAX_AMOUNT,
                SettlementError::Amount
            );
            funding[i][a] = intent.assets[a].funding;
            surplus[i][a] = vault.amount - intent.assets[a].funding;
            recipient_before[i][a] = recipient.amount;
            identities.push(vault_info.key());
            identities.push(recipient_info.key());
        }
        price_guard
            .check_reference_move(intent.assets.map(|asset| asset.funding_reference_price))?;
        intents.push(intent);
    }
    identity_separation(&identities, config_key, &[mints[0].key(), mints[1].key(), mints[2].key()])?;

    // Derive the only permitted debits and credits from the explicit cross records.
    let cash_index = policy.oracle.cash_index as usize;
    let mut debit: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut credit: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut sides: Vec<[u8; 3]> = vec![[0u8; 3]; MAX_BATCH];
    let mut previous: Option<(u8, u8, u8)> = None;
    for cross in &parsed.crosses {
        let stock = cross.stock_index as usize;
        let seller = cross.seller_index as usize;
        let buyer = cross.buyer_index as usize;
        require!(
            stock < 3
                && stock != cash_index
                && seller < batch_count
                && buyer < batch_count
                && seller != buyer,
            SettlementError::BatchRecord
        );
        let key = (cross.stock_index, cross.seller_index, cross.buyer_index);
        if let Some(last) = previous {
            require!(key > last, SettlementError::BatchRecord);
        }
        previous = Some(key);
        require!(
            cross.stock_quantity > 0 && cross.cash_amount > 0,
            SettlementError::BatchRecord
        );
        price_guard.check_cross(stock, cross.stock_quantity, cross.cash_amount)?;
        sides[seller][stock] |= 1;
        sides[buyer][stock] |= 2;
        debit[seller][stock] = checked_add_amount(debit[seller][stock], cross.stock_quantity)?;
        credit[buyer][stock] = checked_add_amount(credit[buyer][stock], cross.stock_quantity)?;
        debit[buyer][cash_index] = checked_add_amount(debit[buyer][cash_index], cross.cash_amount)?;
        credit[seller][cash_index] =
            checked_add_amount(credit[seller][cash_index], cross.cash_amount)?;
    }
    let mut outputs: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    for i in 0..batch_count {
        for a in 0..3 {
            require!(sides[i][a] != 3, SettlementError::BatchRecord);
            require!(debit[i][a] <= funding[i][a], SettlementError::BatchRecord);
            let asset = intents[i].assets[a];
            let output = checked_add_amount(funding[i][a] - debit[i][a], credit[i][a])?;
            require!(
                output >= asset.min_output && output <= asset.max_output,
                SettlementError::Output
            );
            outputs[i][a] = output;
        }
        price_guard.check_value_loss(funding[i], outputs[i])?;
    }
    for a in 0..3 {
        let total_debit = debit
            .iter()
            .try_fold(0u64, |sum, row| checked_add_amount(sum, row[a]))?;
        let total_credit = credit
            .iter()
            .try_fold(0u64, |sum, row| checked_add_amount(sum, row[a]))?;
        require!(
            total_debit == total_credit,
            SettlementError::Conservation
        );
    }

    // Execute internal crossings directly between the two owners' own vaults. Both vault
    // authorities are funding intent PDAs, so no submitter privilege is involved.
    for cross in &parsed.crosses {
        let stock = cross.stock_index as usize;
        let seller = cross.seller_index as usize;
        let buyer = cross.buyer_index as usize;
        let seller_base = seller * ACCOUNTS_PER_INTENT;
        let buyer_base = buyer * ACCOUNTS_PER_INTENT;
        let seller_nonce = intents[seller].nonce.to_le_bytes();
        let seller_bump = [intents[seller].bump];
        let seller_seeds: &[&[u8]] = &[
            b"intent",
            config_key.as_ref(),
            owners[seller].as_ref(),
            seller_nonce.as_ref(),
            &seller_bump,
        ];
        let buyer_nonce = intents[buyer].nonce.to_le_bytes();
        let buyer_bump = [intents[buyer].bump];
        let buyer_seeds: &[&[u8]] = &[
            b"intent",
            config_key.as_ref(),
            owners[buyer].as_ref(),
            buyer_nonce.as_ref(),
            &buyer_bump,
        ];
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: accounts[seller_base + 2 + stock].clone(),
                    mint: mints[stock].clone(),
                    to: accounts[buyer_base + 2 + stock].clone(),
                    authority: accounts[seller_base + 1].clone(),
                },
                &[seller_seeds],
            ),
            cross.stock_quantity,
            policy.assets[stock].decimals,
        )?;
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: accounts[buyer_base + 2 + cash_index].clone(),
                    mint: mints[cash_index].clone(),
                    to: accounts[seller_base + 2 + cash_index].clone(),
                    authority: accounts[buyer_base + 1].clone(),
                },
                &[buyer_seeds],
            ),
            cross.cash_amount,
            policy.assets[cash_index].decimals,
        )?;
    }

    for i in 0..batch_count {
        let base = i * ACCOUNTS_PER_INTENT;
        let nonce = intents[i].nonce.to_le_bytes();
        let bump = [intents[i].bump];
        let signer_seeds: &[&[u8]] = &[
            b"intent",
            config_key.as_ref(),
            owners[i].as_ref(),
            nonce.as_ref(),
            &bump,
        ];
        for a in 0..3 {
            let amount = outputs[i][a];
            if amount > 0 {
                token::transfer_checked(
                    CpiContext::new_with_signer(
                        token_program.key(),
                        TransferChecked {
                            from: accounts[base + 2 + a].clone(),
                            mint: mints[a].clone(),
                            to: accounts[base + 5 + a].clone(),
                            authority: accounts[base + 1].clone(),
                        },
                        &[signer_seeds],
                    ),
                    amount,
                    policy.assets[a].decimals,
                )?;
            }
        }
    }

    // Reload every vault and recipient: each vault must end at its owner-attributed surplus and
    // each recipient must gain exactly its authorized output.
    for i in 0..batch_count {
        let base = i * ACCOUNTS_PER_INTENT;
        let intent_key = accounts[base + 1].key();
        let owner = owners[i];
        for a in 0..3 {
            let vault_after = read_token(&accounts[base + 2 + a], intent_key, mints[a].key())?;
            let recipient_after = read_token(&accounts[base + 5 + a], owner, mints[a].key())?;
            require!(
                vault_after.amount == surplus[i][a]
                    && recipient_after.amount
                        == recipient_before[i][a]
                            .checked_add(outputs[i][a])
                            .ok_or(FundingError::Delta)?,
                FundingError::Delta
            );
        }
    }

    let mut settled_hashes = Vec::with_capacity(batch_count);
    for i in 0..batch_count {
        let intent_info = &accounts[i * ACCOUNTS_PER_INTENT + 1];
        let mut encoded = Vec::with_capacity(Intent::SPACE);
        {
            let intent = &mut intents[i];
            intent.booked_claims = [0; 3];
            intent.status = IntentStatus::Settled;
            intent.try_serialize(&mut encoded)?;
            settled_hashes.push(intent.mandate_hash);
        }
        let mut data = intent_info.try_borrow_mut_data()?;
        require!(encoded.len() == data.len(), SettlementError::BatchAccount);
        data.copy_from_slice(&encoded);
    }
    emit!(BatchSettled {
        config: config_key,
        batch_count: parsed.batch_count,
        snapshot_sequence: parsed.expected_snapshot_sequence,
        mandate_hashes: settled_hashes,
        debits: debit[..batch_count].to_vec(),
        credits: credit[..batch_count].to_vec(),
        outputs: outputs[..batch_count].to_vec(),
    });
    Ok(())
}

fn identity_separation(identities: &[Pubkey], config: Pubkey, mints: &[Pubkey; 3]) -> Result<()> {
    for i in 0..identities.len() {
        require!(
            identities[i] != config && !mints.contains(&identities[i]),
            FundingError::Alias
        );
        for j in i + 1..identities.len() {
            require!(identities[i] != identities[j], FundingError::Alias);
        }
    }
    Ok(())
}

#[event]
pub struct BatchSettled {
    pub config: Pubkey,
    pub batch_count: u8,
    pub snapshot_sequence: u64,
    pub mandate_hashes: Vec<[u8; 32]>,
    pub debits: Vec<[u64; 3]>,
    pub credits: Vec<[u64; 3]>,
    pub outputs: Vec<[u64; 3]>,
}

pub use crate::CrossflowError as SettlementError;

#[cfg(test)]
mod tests {
    use super::*;

    fn body(batch: u8, sequence: u64, crosses: &[(u8, u8, u8, u64, u64)], residuals: u8) -> Vec<u8> {
        let mut bytes = vec![1u8, batch];
        bytes.extend_from_slice(&sequence.to_le_bytes());
        bytes.push(crosses.len() as u8);
        for (stock, seller, buyer, quantity, cash) in crosses {
            bytes.push(*stock);
            bytes.push(*seller);
            bytes.push(*buyer);
            bytes.extend_from_slice(&quantity.to_le_bytes());
            bytes.extend_from_slice(&cash.to_le_bytes());
        }
        bytes.push(residuals);
        bytes
    }

    #[test]
    fn canonical_body_decodes_and_noncanonical_bodies_reject() {
        let canonical = body(3, 7, &[(1, 0, 1, 1000, 10_000_000), (2, 2, 0, 5, 20)], 0);
        let parsed = decode_batch_body(&canonical).unwrap();
        assert_eq!(parsed.batch_count, 3);
        assert_eq!(parsed.expected_snapshot_sequence, 7);
        assert_eq!(parsed.crosses.len(), 2);
        assert_eq!(parsed.crosses[1].stock_quantity, 5);
        let mut trailing = canonical.clone();
        trailing.push(0);
        assert!(decode_batch_body(&trailing).is_err());
        let mut wrong_schema = canonical.clone();
        wrong_schema[0] = 2;
        assert!(decode_batch_body(&wrong_schema).is_err());
        assert!(decode_batch_body(&body(0, 1, &[], 0)).is_err());
        assert!(decode_batch_body(&body(4, 1, &[], 0)).is_err());
        assert!(decode_batch_body(&body(1, 1, &[], 1)).is_err());
        let seven = body(3, 1, &[(1, 0, 1, 1, 1); 7], 0);
        assert!(decode_batch_body(&seven).is_err());
        let truncated = canonical[..canonical.len() - 1].to_vec();
        assert!(decode_batch_body(&truncated).is_err());
    }

    #[test]
    fn maximum_body_is_bounded() {
        let worst = body(3, u64::MAX, &[(1, 0, 1, u64::MAX, u64::MAX); 6], 0);
        // Two header bytes, eight sequence bytes, one cross count, six 19-byte crosses,
        // then the residual count.
        assert_eq!(worst.len(), 2 + 8 + 1 + 6 * 19 + 1);
        assert!(decode_batch_body(&worst).is_ok());
        // The declared capacity still admits the full settlement-accounting maximum, which
        // carries two residual records that T09 must reject rather than mis-length.
        assert_eq!(MAX_BATCH_BODY, 2 + 8 + 1 + 6 * 19 + 1 + 2 * (10 + 8 * 3));
        let mut with_residuals = body(3, 1, &[(1, 0, 1, 1, 1); 6], 2);
        with_residuals.extend_from_slice(&[7u8; 2 * 34]);
        assert_eq!(with_residuals.len(), MAX_BATCH_BODY);
        assert!(decode_batch_body(&with_residuals).is_err());
    }
}
