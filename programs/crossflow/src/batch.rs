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
use crate::route::{self, RouteError};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TransferChecked};

pub const MAX_BATCH: usize = 3;
pub const MAX_CROSSES: usize = 6;
pub const MAX_RESIDUALS: usize = 2;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatchResidual {
    pub stock_index: u8,
    pub direction: u8,
    pub minimum_output: u64,
}

#[derive(Clone, Debug)]
pub struct BatchBody {
    pub batch_count: u8,
    pub expected_snapshot_sequence: u64,
    pub crosses: Vec<BatchCross>,
    /// Typed residual records. The per-owner input contributions are read from the body here and
    /// are the only weights the program will ever use; there is no separate credit array.
    pub residuals: Vec<BatchResidual>,
    pub residual_inputs: Vec<[u64; MAX_BATCH]>,
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
    require!(residual_count <= MAX_RESIDUALS, SettlementError::Instruction);
    let mut residuals = Vec::with_capacity(residual_count);
    let mut residual_inputs = Vec::with_capacity(residual_count);
    for _ in 0..residual_count {
        let record = bytes
            .get(cursor..cursor + 10)
            .ok_or(SettlementError::Instruction)?;
        let mut inputs = [0u64; MAX_BATCH];
        cursor += 10;
        // Exactly `batch_count` weights, matching the canonical encoder and the spec; reading a
        // fixed three would admit a phantom participant for a two-owner batch.
        for slot in inputs.iter_mut().take(batch_count as usize) {
            *slot = read_u64(bytes, cursor)?;
            cursor += 8;
        }
        residuals.push(BatchResidual {
            stock_index: record[0],
            direction: record[1],
            minimum_output: read_u64(record, 2)?,
        });
        residual_inputs.push(inputs);
    }
    require!(cursor == bytes.len(), SettlementError::Instruction);
    Ok(BatchBody {
        batch_count,
        expected_snapshot_sequence,
        crosses,
        residuals,
        residual_inputs,
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

/// Anchor caches a deserialized token account, so any post-CPI comparison must re-read the
/// account data rather than the stale cached field.
fn raw_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    require!(data.len() == 165 && *info.owner == token::ID, FundingError::TokenIdentity);
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(bytes))
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


/// One validated owner group. Both settlement paths load intents through this single
/// implementation so a routed batch cannot validate its accounts more weakly than an internal one.
pub(crate) struct LoadedGroup {
    pub intent: Box<Intent>,
    pub owner: Pubkey,
    pub intent_key: Pubkey,
    pub funding: [u64; 3],
    pub surplus: [u64; 3],
    pub recipient_before: [u64; 3],
    pub identities: Vec<Pubkey>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn load_group(
    accounts: &[AccountInfo],
    base: usize,
    index: usize,
    previous_owner: Option<Pubkey>,
    config_key: Pubkey,
    now: i64,
    policy: &crate::config::Policy,
    mints: &[AccountInfo],
) -> Result<Box<LoadedGroup>> {
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
        Pubkey::find_program_address(&[b"owner", config_key.as_ref(), owner.as_ref()], &crate::ID).0
            == owner_state_info.key()
            && Pubkey::find_program_address(
                &[b"intent", config_key.as_ref(), owner.as_ref(), intent.nonce.to_le_bytes().as_ref()],
                &crate::ID,
            )
            .0 == intent_info.key(),
        SettlementError::BatchAccount
    );
    require!(
        intent.status == IntentStatus::Funded
            && u64::try_from(now).is_ok_and(|value| value < intent.expiry_unix_seconds),
        SettlementError::Settle
    );
    if let Some(previous) = previous_owner {
        require!(previous < owner, SettlementError::BatchAccount);
    }
    let _ = index;
    let mut identities = vec![owner_state_info.key(), intent_info.key()];
    let mut funding = [0u64; 3];
    let mut surplus = [0u64; 3];
    let mut recipient_before = [0u64; 3];
    for a in 0..3 {
        let mint = &mints[a];
        // Read the real mint flags. Substituting `*mint.owner == token::ID` and `true` for the
        // authority checks would make this path admit a mint the funding path rejects.
        let (initialized, decimals, mint_authority_none, freeze_authority_none) = {
            let data = mint.try_borrow_data()?;
            require!(data.len() == 82, FundingError::Mint);
            (
                data[45] == 1,
                data[44],
                data[0..4] == [0, 0, 0, 0],
                data[46..50] == [0, 0, 0, 0],
            )
        };
        validate_mint_policy(
            mint.key(),
            *mint.owner,
            mint.data_len(),
            initialized,
            decimals,
            mint_authority_none,
            freeze_authority_none,
            &policy.assets[a],
        )?;
        let vault_info = &accounts[base + 2 + a];
        let recipient_info = &accounts[base + 5 + a];
        require!(
            vault_info.is_writable && recipient_info.is_writable,
            SettlementError::BatchAccount
        );
        require!(
            vault_info.key() == vault_for(intent_info.key(), mint.key())?
                && recipient_info.key() == recipient_for(owner, mint.key())?
                && intent.vaults[a] == vault_info.key()
                && intent.recipients[a] == recipient_info.key(),
            FundingError::TokenIdentity
        );
        let vault = read_token(vault_info, intent_info.key(), mint.key())?;
        let recipient = read_token(recipient_info, owner, mint.key())?;
        require!(
            intent.booked_claims[a] == intent.assets[a].funding
                && vault.amount >= intent.booked_claims[a],
            SettlementError::Settle
        );
        require!(
            vault.amount <= MAX_POOL_AMOUNT && intent.assets[a].funding <= MAX_AMOUNT,
            SettlementError::Amount
        );
        funding[a] = intent.assets[a].funding;
        surplus[a] = vault.amount - intent.assets[a].funding;
        recipient_before[a] = recipient.amount;
        identities.push(vault_info.key());
        identities.push(recipient_info.key());
    }
    Ok(Box::new(LoadedGroup {
        intent,
        owner,
        intent_key: intent_info.key(),
        funding,
        surplus,
        recipient_before,
        identities,
    }))
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
    // This instruction settles internal crossings only. A body that carries residual records is
    // a routed proposal and must go to `settle_routed`, which owns the venue accounts.
    require!(parsed.residuals.is_empty(), SettlementError::Instruction);
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

    let token_program = ctx.accounts.token_program.to_account_info();
    let accounts = ctx.remaining_accounts;
    require!(
        accounts.len() == batch_count * ACCOUNTS_PER_INTENT,
        SettlementError::BatchAccount
    );

    // One shared validation pass, identical to the routed path.
    let mints = vec![
        ctx.accounts.mint0.to_account_info(),
        ctx.accounts.mint1.to_account_info(),
        ctx.accounts.mint2.to_account_info(),
    ];
    let mut loaded: Vec<Box<LoadedGroup>> = Vec::with_capacity(batch_count);
    let mut owners: Vec<Pubkey> = Vec::with_capacity(batch_count);
    let mut funding: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut surplus: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut recipient_before: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    let mut identities: Vec<Pubkey> = Vec::new();
    for i in 0..batch_count {
        let group = load_group(
            accounts,
            i * ACCOUNTS_PER_INTENT,
            i,
            owners.last().copied(),
            config_key,
            now,
            &policy,
            &mints,
        )?;
        price_guard.check_reference_move(
            group.intent.assets.map(|asset| asset.funding_reference_price),
        )?;
        owners.push(group.owner);
        funding[i] = group.funding;
        surplus[i] = group.surplus;
        recipient_before[i] = group.recipient_before;
        identities.extend(group.identities.iter().copied());
        loaded.push(group);
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
            let asset = loaded[i].intent.assets[a];
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
        let seller_nonce = loaded[seller].intent.nonce.to_le_bytes();
        let seller_bump = [loaded[seller].intent.bump];
        let seller_seeds: &[&[u8]] = &[
            b"intent",
            config_key.as_ref(),
            owners[seller].as_ref(),
            seller_nonce.as_ref(),
            &seller_bump,
        ];
        let buyer_nonce = loaded[buyer].intent.nonce.to_le_bytes();
        let buyer_bump = [loaded[buyer].intent.bump];
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
        let nonce = loaded[i].intent.nonce.to_le_bytes();
        let bump = [loaded[i].intent.bump];
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
            let intent = &mut loaded[i].intent;
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

    fn body(batch: u8, sequence: u64, crosses: &[(u8, u8, u8, u64, u64)], residuals: &[(u8, u8, u64, [u64; 3])]) -> Vec<u8> {
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
        bytes.push(residuals.len() as u8);
        for (stock, direction, minimum, inputs) in residuals {
            bytes.push(*stock);
            bytes.push(*direction);
            bytes.extend_from_slice(&minimum.to_le_bytes());
            for amount in inputs.iter().take(batch as usize) {
                bytes.extend_from_slice(&amount.to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn canonical_body_decodes_and_noncanonical_bodies_reject() {
        let canonical = body(3, 7, &[(1, 0, 1, 1000, 10_000_000), (2, 2, 0, 5, 20)], &[]);
        let parsed = decode_batch_body(&canonical).unwrap();
        assert_eq!(parsed.batch_count, 3);
        assert_eq!(parsed.expected_snapshot_sequence, 7);
        assert_eq!(parsed.crosses.len(), 2);
        assert_eq!(parsed.crosses[1].stock_quantity, 5);
        assert!(parsed.residuals.is_empty());
        let mut trailing = canonical.clone();
        trailing.push(0);
        assert!(decode_batch_body(&trailing).is_err());
        let mut wrong_schema = canonical.clone();
        wrong_schema[0] = 2;
        assert!(decode_batch_body(&wrong_schema).is_err());
        assert!(decode_batch_body(&body(0, 1, &[], &[])).is_err());
        assert!(decode_batch_body(&body(4, 1, &[], &[])).is_err());
        // A residual whose weights were never written is truncated, not silently zero-filled.
        let short = body(3, 1, &[], &[(1, 0, 10, [1, 1, 1])]);
        assert!(decode_batch_body(&short[..short.len() - 8]).is_err());
        // A two-owner residual carries exactly two weights, as the canonical encoder writes.
        let two = body(2, 1, &[], &[(1, 0, 10, [4, 5, 0])]);
        let decoded = decode_batch_body(&two).unwrap();
        assert_eq!(decoded.residual_inputs[0], [4, 5, 0]);
        let seven = body(3, 1, &[(1, 0, 1, 1, 1); 7], &[]);
        assert!(decode_batch_body(&seven).is_err());
        let truncated = canonical[..canonical.len() - 1].to_vec();
        assert!(decode_batch_body(&truncated).is_err());
    }

    #[test]
    fn residual_records_decode_with_their_exact_input_weights() {
        let decoded = decode_batch_body(&body(3, 1, &[], &[(1, 0, 9_000, [3, 0, 7])])).unwrap();
        assert_eq!(decoded.residuals.len(), 1);
        assert_eq!(decoded.residuals[0].stock_index, 1);
        assert_eq!(decoded.residuals[0].direction, 0);
        assert_eq!(decoded.residuals[0].minimum_output, 9_000);
        assert_eq!(decoded.residual_inputs[0], [3, 0, 7]);
        let three = body(3, 1, &[], &[(1, 0, 1, [1, 1, 1]); 3]);
        assert!(decode_batch_body(&three).is_err());
    }

    #[test]
    fn maximum_body_is_bounded() {
        let worst = body(3, u64::MAX, &[(1, 0, 1, u64::MAX, u64::MAX); 6], &[]);
        // Two header bytes, eight sequence bytes, one cross count, six 19-byte crosses,
        // then the residual count.
        assert_eq!(worst.len(), 2 + 8 + 1 + 6 * 19 + 1);
        assert!(decode_batch_body(&worst).is_ok());
        // The declared capacity still admits the full settlement-accounting maximum.
        assert_eq!(MAX_BATCH_BODY, 2 + 8 + 1 + 6 * 19 + 1 + 2 * (10 + 8 * 3));
        let with_residuals = body(3, 1, &[(1, 0, 1, 1, 1); 6], &[(1, 0, 1, [1, 1, 1]), (2, 1, 1, [1, 1, 1])]);
        assert_eq!(with_residuals.len(), MAX_BATCH_BODY);
        let decoded = decode_batch_body(&with_residuals).unwrap();
        assert_eq!(decoded.residuals.len(), 2);
        assert_eq!(decoded.residual_inputs[1], [1, 1, 1]);
    }
}

/// Routed settlement: the same bounded batch, but every debit is first pooled so an admitted
/// residual leg can be executed against the committed venue before credits are returned.
///
/// This is a separate instruction from `settle_batch` only because the route adds pinned
/// accounts; the body format, the account-group validation, the cross rules and the output
/// bounds are shared. The reviewed internal-only path is untouched.
#[derive(Accounts)]
pub struct SettleRouted<'info> {
    #[account(seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub prices: Box<Account<'info, FixtureSnapshot>>,
    pub mint0: Box<Account<'info, Mint>>,
    pub mint1: Box<Account<'info, Mint>>,
    pub mint2: Box<Account<'info, Mint>>,
    /// CHECK: derived batch PDA; verified in the handler and the only pool authority.
    pub batch_authority: UncheckedAccount<'info>,
    /// CHECK: canonical pool ATA of the batch PDA for mint0; derived and verified in the handler.
    #[account(mut)]
    pub pool0: UncheckedAccount<'info>,
    /// CHECK: canonical pool ATA of the batch PDA for mint1; derived and verified in the handler.
    #[account(mut)]
    pub pool1: UncheckedAccount<'info>,
    /// CHECK: canonical pool ATA of the batch PDA for mint2; derived and verified in the handler.
    #[account(mut)]
    pub pool2: UncheckedAccount<'info>,
    /// CHECK: pinned venue program from the committed policy.
    pub venue_program: UncheckedAccount<'info>,
    /// CHECK: pinned venue pool from the committed policy.
    #[account(mut)]
    pub venue_pool: UncheckedAccount<'info>,
    /// CHECK: pinned venue vault for mint0 from the committed policy.
    #[account(mut)]
    pub venue_vault0: UncheckedAccount<'info>,
    /// CHECK: pinned venue vault for mint1 from the committed policy.
    #[account(mut)]
    pub venue_vault1: UncheckedAccount<'info>,
    /// CHECK: pinned venue vault for mint2 from the committed policy.
    #[account(mut)]
    pub venue_vault2: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: exact sysvar ID is constrained; the handler authenticates the current instruction.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn settle_routed<'info>(
    ctx: Context<'info, SettleRouted<'info>>,
    body: Vec<u8>,
) -> Result<()> {
    exact_batch_instruction(&ctx.accounts.instructions_sysvar.to_account_info(), body.len())?;
    let parsed = decode_batch_body(&body)?;
    let batch_count = parsed.batch_count as usize;
    require!(batch_count >= 2, SettlementError::Settle);
    require!(
        !parsed.residuals.is_empty() && parsed.residuals.len() <= MAX_RESIDUALS,
        SettlementError::Instruction
    );
    let config_key = ctx.accounts.config.key();
    let policy = ctx.accounts.config.validate(config_key)?;
    require!(!ctx.accounts.config.settlement_paused, FundingError::Paused);
    require!(policy.route.enabled(), RouteError::RouteDisabled);
    let now = Clock::get()?.unix_timestamp;
    let price_guard = oracle::read_fixture(
        &ctx.accounts.prices.to_account_info(),
        &policy.binding(ctx.accounts.config.policy_hash),
        ctx.accounts.config.policy_hash,
        parsed.expected_snapshot_sequence,
        now,
    )?;

    let mints = vec![
        ctx.accounts.mint0.to_account_info(),
        ctx.accounts.mint1.to_account_info(),
        ctx.accounts.mint2.to_account_info(),
    ];
    let token_program = ctx.accounts.token_program.to_account_info();
    let ata_program = ctx.accounts.associated_token_program.to_account_info();
    let accounts = ctx.remaining_accounts;
    require!(
        accounts.len() == batch_count * ACCOUNTS_PER_INTENT,
        SettlementError::BatchAccount
    );

    // 1. One shared validation pass for every owner group.
    let mut loaded: Vec<Box<LoadedGroup>> = Vec::with_capacity(batch_count);
    let mut identities: Vec<Pubkey> = Vec::new();
    for i in 0..batch_count {
        let group = load_group(
            accounts,
            i * ACCOUNTS_PER_INTENT,
            i,
            loaded.last().map(|previous| previous.owner),
            config_key,
            now,
            &policy,
            &mints,
        )?;
        identities.extend(group.identities.iter().copied());
        price_guard.check_reference_move(
            group.intent.assets.map(|asset| asset.funding_reference_price),
        )?;
        loaded.push(group);
    }
    identity_separation(&identities, config_key, &[mints[0].key(), mints[1].key(), mints[2].key()])?;
    let owners: Vec<Pubkey> = loaded.iter().map(|group| group.owner).collect();
    let funding: Vec<[u64; 3]> = loaded.iter().map(|group| group.funding).collect();
    let surplus: Vec<[u64; 3]> = loaded.iter().map(|group| group.surplus).collect();
    let recipient_before: Vec<[u64; 3]> = loaded.iter().map(|group| group.recipient_before).collect();

    // 2. The batch PDA and its three pool accounts are derived, never caller-chosen.
    let (batch_authority, batch_bump) =
        Pubkey::find_program_address(&[b"batch", config_key.as_ref()], &crate::ID);
    require!(
        ctx.accounts.batch_authority.key() == batch_authority,
        RouteError::RouteIdentity
    );
    let pool_accounts = vec![
        ctx.accounts.pool0.to_account_info(),
        ctx.accounts.pool1.to_account_info(),
        ctx.accounts.pool2.to_account_info(),
    ];
    for a in 0..3 {
        require!(
            *pool_accounts[a].key == route::canonical_ata(&batch_authority, &mints[a].key())
                && pool_accounts[a].is_writable,
            RouteError::RouteVault
        );
        for i in 0..batch_count {
            let base = i * ACCOUNTS_PER_INTENT;
            require!(
                *pool_accounts[a].key != accounts[base + 2 + a].key()
                    && *pool_accounts[a].key != accounts[base + 5 + a].key()
                    && *pool_accounts[a].key != policy.route.vaults[a],
                FundingError::Alias
            );
        }
    }
    let venue_vaults = vec![
        ctx.accounts.venue_vault0.to_account_info(),
        ctx.accounts.venue_vault1.to_account_info(),
        ctx.accounts.venue_vault2.to_account_info(),
    ];
    require!(
        ctx.accounts.venue_program.key() == policy.route.program
            && ctx.accounts.venue_pool.key() == policy.route.pool
            && (0..3).all(|a| *venue_vaults[a].key == policy.route.vaults[a]),
        RouteError::RouteIdentity
    );
    let venue_program = ctx.accounts.venue_program.to_account_info();
    let venue_pool = ctx.accounts.venue_pool.to_account_info();
    let batch_authority_info = ctx.accounts.batch_authority.to_account_info();
    let batch_seeds: [&[u8]; 3] = [b"batch", config_key.as_ref(), &[batch_bump]];

    // 3. Pool accounts exist only transiently inside this transaction and must start empty.
    for a in 0..3 {
        let pool = read_token(&pool_accounts[a], batch_authority, policy.assets[a].mint)?;
        require!(pool.amount == 0, RouteError::PoolNotClean);
    }

    // 4. Internal crosses: identical rules to the internal-only path.
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
            stock < 3 && stock != cash_index && seller < batch_count && buyer < batch_count
                && seller != buyer,
            SettlementError::BatchRecord
        );
        let key = (cross.stock_index, cross.seller_index, cross.buyer_index);
        if let Some(last) = previous {
            require!(key > last, SettlementError::BatchRecord);
        }
        previous = Some(key);
        require!(cross.stock_quantity > 0 && cross.cash_amount > 0, SettlementError::BatchRecord);
        price_guard.check_cross(stock, cross.stock_quantity, cross.cash_amount)?;
        sides[seller][stock] |= 1;
        sides[buyer][stock] |= 2;
        debit[seller][stock] = checked_add_amount(debit[seller][stock], cross.stock_quantity)?;
        credit[buyer][stock] = checked_add_amount(credit[buyer][stock], cross.stock_quantity)?;
        debit[buyer][cash_index] = checked_add_amount(debit[buyer][cash_index], cross.cash_amount)?;
        credit[seller][cash_index] = checked_add_amount(credit[seller][cash_index], cross.cash_amount)?;
    }

    // 5. Typed residual records. The caller supplies only a direction, a minimum output and each
    // owner's exact input contribution; there is no credit weight anywhere in the body.
    let mut previous_stock: Option<u8> = None;
    let mut claimed_stocks: [bool; 3] = [false; 3];
    let mut legs: Vec<(usize, usize, [u64; 3], u64)> = Vec::new();
    for (index, record) in parsed.residuals.iter().enumerate() {
        let stock = record.stock_index as usize;
        let direction = record.direction as usize;
        require!(
            stock < 3 && stock != cash_index && direction <= 1,
            SettlementError::BatchRecord
        );
        if let Some(last) = previous_stock {
            require!(record.stock_index > last, SettlementError::BatchRecord);
        }
        previous_stock = Some(record.stock_index);
        require!(record.minimum_output > 0 && record.minimum_output <= MAX_POOL_AMOUNT, SettlementError::BatchRecord);
        require!(claimed_stocks[stock] == false, SettlementError::BatchRecord);
        claimed_stocks[stock] = true;
        let inputs = parsed.residual_inputs[index];
        let input_asset = if direction == 0 { stock } else { cash_index };
        let output_asset = if direction == 0 { cash_index } else { stock };
        let mut total_input = 0u64;
        for i in 0..batch_count {
            require!(inputs[i] <= MAX_AMOUNT, SettlementError::Amount);
            if inputs[i] == 0 {
                continue;
            }
            sides[i][stock] |= if direction == 0 { 1 } else { 2 };
            debit[i][input_asset] = checked_add_amount(debit[i][input_asset], inputs[i])?;
            total_input = checked_add_amount(total_input, inputs[i])?;
        }
        require!(total_input > 0 && total_input <= MAX_POOL_AMOUNT, SettlementError::BatchRecord);
        legs.push((input_asset, output_asset, inputs, record.minimum_output));
    }
    for i in 0..batch_count {
        for a in 0..3 {
            require!(sides[i][a] != 3, SettlementError::BatchRecord);
            require!(debit[i][a] <= funding[i][a], SettlementError::BatchRecord);
        }
    }

    // 6. Intake: every debit moves into the pool before anything is quoted.
    for i in 0..batch_count {
        let base = i * ACCOUNTS_PER_INTENT;
        let nonce = loaded[i].intent.nonce.to_le_bytes();
        let bump = [loaded[i].intent.bump];
        let seeds: &[&[u8]] = &[b"intent", config_key.as_ref(), owners[i].as_ref(), nonce.as_ref(), &bump];
        for a in 0..3 {
            if debit[i][a] == 0 {
                continue;
            }
            token::transfer_checked(
                CpiContext::new_with_signer(token_program.key(), TransferChecked {
                    from: accounts[base + 2 + a].clone(),
                    mint: mints[a].clone(),
                    to: pool_accounts[a].clone(),
                    authority: accounts[base + 1].clone(),
                }, &[seeds]),
                debit[i][a],
                policy.assets[a].decimals,
            )?;
        }
    }
    let mut pool_expected = [0u64; 3];
    for a in 0..3 {
        pool_expected[a] = debit.iter().try_fold(0u64, |sum, row| checked_add_amount(sum, row[a]))?;
        require!(
            read_token(&pool_accounts[a], batch_authority, policy.assets[a].mint)?.amount
                == pool_expected[a],
            FundingError::Delta
        );
    }

    // 7. Execute each admitted leg against the pinned venue and allocate the measured output by
    // the owners' actual input contribution.
    let mut owner_outputs: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    for (input_asset, output_asset, inputs, minimum_output) in &legs {
        let total_input = inputs.iter().take(batch_count).try_fold(0u64, |sum, value| {
            checked_add_amount(sum, *value)
        })?;
        let venue_in_before = raw_amount(&venue_vaults[*input_asset])?;
        let venue_out_before = raw_amount(&venue_vaults[*output_asset])?;
        let destination_before =
            read_token(&pool_accounts[*output_asset], batch_authority, policy.assets[*output_asset].mint)?.amount;
        let third = 3 - input_asset - output_asset;
        let third_before =
            read_token(&pool_accounts[third], batch_authority, policy.assets[third].mint)?.amount;
        route::swap(
            &policy.route,
            &route::RouteLeg {
                program: &venue_program,
                pool: &venue_pool,
                mint_in: &mints[*input_asset],
                mint_out: &mints[*output_asset],
                source: &pool_accounts[*input_asset],
                destination: &pool_accounts[*output_asset],
                vault_in: &venue_vaults[*input_asset],
                vault_out: &venue_vaults[*output_asset],
                token_program: &token_program,
                associated_token_program: &ata_program,
                batch_authority: &batch_authority_info,
            },
            batch_authority,
            *input_asset as u8,
            *output_asset as u8,
            total_input,
            *minimum_output,
            &batch_seeds,
        )?;
        let destination_after =
            read_token(&pool_accounts[*output_asset], batch_authority, policy.assets[*output_asset].mint)?.amount;
        let measured = destination_after
            .checked_sub(destination_before)
            .ok_or(SettlementError::Conservation)?;
        require!(measured > 0 && measured >= *minimum_output, RouteError::RouteOutput);
        let third_after =
            read_token(&pool_accounts[third], batch_authority, policy.assets[third].mint)?.amount;
        require!(third_after == third_before, RouteError::RouteOutput);
        // The pinned venue's own reserves must move by exactly the typed input and measured output.
        require!(
            raw_amount(&venue_vaults[*input_asset])?
                == venue_in_before.checked_add(total_input).ok_or(SettlementError::Conservation)?
                && raw_amount(&venue_vaults[*output_asset])?
                    == venue_out_before.checked_sub(measured).ok_or(SettlementError::Conservation)?,
            RouteError::RouteOutput
        );
        let stock = if *input_asset == cash_index { *output_asset } else { *input_asset };
        let allocation = crate::math::largest_remainder_three(measured, *inputs, [
            owners[0],
            owners.get(1).copied().unwrap_or_default(),
            owners.get(2).copied().unwrap_or_default(),
        ])?;
        let mut total_stock = 0u64;
        let mut total_cash = 0u64;
        for i in 0..batch_count {
            if inputs[i] == 0 {
                continue;
            }
            owner_outputs[i][*output_asset] =
                checked_add_amount(owner_outputs[i][*output_asset], allocation[i])?;
            let (q, k) = if *input_asset == cash_index {
                (allocation[i], inputs[i])
            } else {
                (inputs[i], allocation[i])
            };
            price_guard.check_external_fill(stock, q, k)?;
            total_stock = checked_add_amount(total_stock, q)?;
            total_cash = checked_add_amount(total_cash, k)?;
        }
        price_guard.check_external_total(stock, total_stock, total_cash)?;
    }

    // 8. Credits, final bounds and the whole-slice guard on the realized outputs.
    let mut outputs: Vec<[u64; 3]> = vec![[0u64; 3]; MAX_BATCH];
    for i in 0..batch_count {
        for a in 0..3 {
            let credit_total = checked_add_amount(credit[i][a], owner_outputs[i][a])?;
            let asset = loaded[i].intent.assets[a];
            let output = checked_add_amount(funding[i][a] - debit[i][a], credit_total)?;
            require!(
                output >= asset.min_output && output <= asset.max_output,
                SettlementError::Output
            );
            outputs[i][a] = output;
            credit[i][a] = credit_total;
        }
        price_guard.check_value_loss(funding[i], outputs[i])?;
    }
    // Reconcile the pools against what every owner's credit now claims. The measured balance must
    // equal the sum of credits exactly, so a route cannot consume internally owed value or leave
    // an unexplained residual behind.
    for a in 0..3 {
        let total_credit =
            credit.iter().try_fold(0u64, |sum, row| checked_add_amount(sum, row[a]))?;
        require!(
            read_token(&pool_accounts[a], batch_authority, policy.assets[a].mint)?.amount
                == total_credit,
            SettlementError::Conservation
        );
    }
    let _ = pool_expected;

    // 9. Return each owner's credit, then pay the authorized output to its fixed recipient.
    for i in 0..batch_count {
        let base = i * ACCOUNTS_PER_INTENT;
        let nonce = loaded[i].intent.nonce.to_le_bytes();
        let bump = [loaded[i].intent.bump];
        let seeds: &[&[u8]] = &[b"intent", config_key.as_ref(), owners[i].as_ref(), nonce.as_ref(), &bump];
        for a in 0..3 {
            // Credit and payout are independent: an owner with a pure debit has no credit but
            // still receives a positive authorized output.
            if credit[i][a] > 0 {
                token::transfer_checked(
                    CpiContext::new_with_signer(token_program.key(), TransferChecked {
                        from: pool_accounts[a].clone(),
                        mint: mints[a].clone(),
                        to: accounts[base + 2 + a].clone(),
                        authority: ctx.accounts.batch_authority.to_account_info(),
                    }, &[&batch_seeds]),
                    credit[i][a],
                    policy.assets[a].decimals,
                )?;
            }
            if outputs[i][a] > 0 {
                token::transfer_checked(
                    CpiContext::new_with_signer(token_program.key(), TransferChecked {
                        from: accounts[base + 2 + a].clone(),
                        mint: mints[a].clone(),
                        to: accounts[base + 5 + a].clone(),
                        authority: accounts[base + 1].clone(),
                    }, &[seeds]),
                    outputs[i][a],
                    policy.assets[a].decimals,
                )?;
            }
        }
    }

    // 10. Nothing may be left behind anywhere.
    for i in 0..batch_count {
        let base = i * ACCOUNTS_PER_INTENT;
        for a in 0..3 {
            require!(
                read_token(&accounts[base + 2 + a], loaded[i].intent_key, mints[a].key())?.amount
                    == surplus[i][a]
                    && read_token(&accounts[base + 5 + a], owners[i], mints[a].key())?.amount
                        == recipient_before[i][a]
                            .checked_add(outputs[i][a])
                            .ok_or(FundingError::Delta)?,
                FundingError::Delta
            );
        }
    }
    for a in 0..3 {
        require!(
            read_token(&pool_accounts[a], batch_authority, policy.assets[a].mint)?.amount == 0,
            RouteError::PoolNotClean
        );
    }

    let mut settled_hashes = Vec::with_capacity(batch_count);
    for i in 0..batch_count {
        let intent_info = &accounts[i * ACCOUNTS_PER_INTENT + 1];
        let mut encoded = Vec::with_capacity(Intent::SPACE);
        {
            let intent = &mut loaded[i].intent;
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
