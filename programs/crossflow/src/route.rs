//! T16 residual routing: the only CPI shape CrossFlow ever forwards.
//!
//! Nothing here is caller-supplied. The venue program, the pool, the pool authority and the two
//! vaults all come from the committed policy; the source and destination must be the pool
//! authority's own canonical associated token accounts for the configured mints, derived here
//! rather than trusted. The instruction is rebuilt from typed arguments — there is no forwarded
//! byte blob and no arbitrary account list.
use crate::config::RoutePolicy;
pub use crate::CrossflowError as RouteError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

/// `sha256("global:swap")[..8]` for the pinned venue program.
pub const VENUE_SWAP_DISCRIMINATOR: [u8; 8] = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];

pub fn canonical_ata(authority: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[authority.as_ref(), anchor_spl::token::ID.as_ref(), mint.as_ref()],
        &anchor_spl::associated_token::ID,
    )
    .0
}

/// Borrowed on purpose: an owned struct of eleven `AccountInfo` values costs ~530 bytes of
/// stack at every call site, and the routed handler is already close to the frame limit.
pub struct RouteLeg<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    pub mint_in: &'a AccountInfo<'info>,
    pub mint_out: &'a AccountInfo<'info>,
    pub source: &'a AccountInfo<'info>,
    pub destination: &'a AccountInfo<'info>,
    pub vault_in: &'a AccountInfo<'info>,
    pub vault_out: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub batch_authority: &'a AccountInfo<'info>,
}

/// Validate every identity and forward exactly one exact-in swap to the pinned venue.
#[allow(clippy::too_many_arguments)]
pub fn swap<'info>(
    route: &RoutePolicy,
    leg: &RouteLeg<'_, 'info>,
    expected_authority: Pubkey,
    input_index: u8,
    output_index: u8,
    amount_in: u64,
    min_out: u64,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    require!(route.enabled(), RouteError::RouteDisabled);
    let input = input_index as usize;
    let output = output_index as usize;
    require!(
        input < 3 && output < 3 && input != output && route.max_legs >= 1,
        RouteError::RouteIdentity
    );
    // Two distinct authorities: the venue pool owns the venue's reserves (pinned by the policy),
    // while CrossFlow's own batch PDA is the only account that may sign a swap for its pools.
    // The batch PDA is not an outer signer; `invoke_signed` grants it below. Here we only require
    // that no other account is being substituted for it.
    require!(
        *leg.program.key == route.program
            && *leg.pool.key == route.pool
            && *leg.batch_authority.key == expected_authority,
        RouteError::RouteIdentity
    );
    require!(
        *leg.vault_in.key == route.vaults[input] && *leg.vault_out.key == route.vaults[output],
        RouteError::RouteVault
    );
    require!(
        *leg.source.key == canonical_ata(&expected_authority, leg.mint_in.key)
            && *leg.destination.key == canonical_ata(&expected_authority, leg.mint_out.key),
        RouteError::RouteVault
    );
    require!(
        *leg.token_program.key == anchor_spl::token::ID
            && *leg.associated_token_program.key == anchor_spl::associated_token::ID
            && amount_in > 0,
        RouteError::RouteIdentity
    );

    let mut data = Vec::with_capacity(26);
    data.extend_from_slice(&VENUE_SWAP_DISCRIMINATOR);
    data.push(input_index);
    data.push(output_index);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    let accounts = vec![
        AccountMeta::new_readonly(expected_authority, true),
        AccountMeta::new(route.pool, false),
        AccountMeta::new_readonly(*leg.mint_in.key, false),
        AccountMeta::new_readonly(*leg.mint_out.key, false),
        AccountMeta::new(*leg.source.key, false),
        AccountMeta::new(*leg.destination.key, false),
        AccountMeta::new(*leg.vault_in.key, false),
        AccountMeta::new(*leg.vault_out.key, false),
        AccountMeta::new_readonly(anchor_spl::token::ID, false),
        AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
    ];
    let instruction = Instruction { program_id: route.program, accounts, data };
    let account_infos: Vec<AccountInfo> = vec![
        leg.batch_authority.clone(),
        leg.pool.clone(),
        leg.mint_in.clone(),
        leg.mint_out.clone(),
        leg.source.clone(),
        leg.destination.clone(),
        leg.vault_in.clone(),
        leg.vault_out.clone(),
        leg.token_program.clone(),
        leg.associated_token_program.clone(),
    ];
    invoke_signed(&instruction, &account_infos, &[signer_seeds])?;
    Ok(())
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn venue_discriminator_matches_the_pinned_instruction_name() {
        // Recomputed independently in scripts/check-t16-runtime-evidence.mjs.
        assert_eq!(
            VENUE_SWAP_DISCRIMINATOR,
            [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]
        );
        let expected = Pubkey::find_program_address(
            &[Pubkey::new_from_array([7; 32]).as_ref(), anchor_spl::token::ID.as_ref(), Pubkey::new_from_array([9; 32]).as_ref()],
            &anchor_spl::associated_token::ID,
        )
        .0;
        assert_eq!(canonical_ata(&Pubkey::new_from_array([7; 32]), &Pubkey::new_from_array([9; 32])), expected);
    }
}
