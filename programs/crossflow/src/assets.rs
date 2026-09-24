//! Admission boundary for the deliberately narrow legacy SPL asset set.
use crate::config::AssetPolicy;
use anchor_lang::prelude::*;
use anchor_spl::token;

pub(crate) fn validate_mint_policy(
    key: Pubkey,
    owner_program: Pubkey,
    data_len: usize,
    initialized: bool,
    decimals: u8,
    mint_authority_none: bool,
    freeze_authority_none: bool,
    asset: &AssetPolicy,
) -> Result<()> {
    validate_legacy_mint(owner_program, data_len, initialized, decimals, mint_authority_none, freeze_authority_none)?;
    require!(
        key == asset.mint
            && asset.token_program == token::ID
            && decimals == asset.decimals,
        AssetError::Mint
    );
    Ok(())
}

/// Closed-vault recovery accepts an old admitted mint after policy rotation,
/// but still refuses Token-2022, mutable supply/freeze authorities and extensions.
pub(crate) fn validate_legacy_mint(
    owner_program: Pubkey,
    data_len: usize,
    initialized: bool,
    decimals: u8,
    mint_authority_none: bool,
    freeze_authority_none: bool,
) -> Result<()> {
    require!(owner_program == token::ID && data_len == 82 && initialized && decimals <= 9
        && mint_authority_none && freeze_authority_none, AssetError::Mint);
    Ok(())
}

pub use crate::CrossflowError as AssetError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_program_extension_authority_decimals_and_mint() {
        let mint = Pubkey::new_from_array([3; 32]);
        let asset = AssetPolicy { mint, token_program: token::ID, decimals: 6, feed_id: [4; 32] };
        let check = |key, program, len, initialized, decimals, mint_none, freeze_none, policy: &AssetPolicy| {
            validate_mint_policy(key, program, len, initialized, decimals, mint_none, freeze_none, policy).is_ok()
        };
        assert!(check(mint, token::ID, 82, true, 6, true, true, &asset));
        assert!(!check(mint, Pubkey::new_from_array([9; 32]), 82, true, 6, true, true, &asset));
        assert!(!check(mint, token::ID, 83, true, 6, true, true, &asset));
        assert!(!check(mint, token::ID, 82, false, 6, true, true, &asset));
        assert!(!check(mint, token::ID, 82, true, 9, true, true, &asset));
        assert!(!check(mint, token::ID, 82, true, 6, false, true, &asset));
        assert!(!check(mint, token::ID, 82, true, 6, true, false, &asset));
        assert!(!check(Pubkey::new_from_array([5; 32]), token::ID, 82, true, 6, true, true, &asset));
        let changed_policy = AssetPolicy { token_program: Pubkey::new_from_array([8; 32]), ..asset };
        assert!(!check(mint, token::ID, 82, true, 6, true, true, &changed_policy));
    }
}
