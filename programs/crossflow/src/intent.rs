use crate::config::Policy;
use crate::oracle::MAX_AMOUNT;
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default, Debug)]
pub struct FundAsset {
    pub funding: u64,
    pub min_output: u64,
    pub max_output: u64,
    pub funding_reference_price: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug)]
pub struct FundRequest {
    pub schema_version: u8,
    pub expected_policy_hash: [u8; 32],
    pub nonce: u64,
    pub expiry_unix_seconds: u64,
    pub optimization_commitment: [u8; 32],
    pub assets: [FundAsset; 3],
}
impl FundRequest {
    pub fn validate(&self, policy_hash: [u8; 32], now: i64, lifetime: u32) -> Result<()> {
        require!(
            self.schema_version == 1
                && self.expected_policy_hash == policy_hash
                && self.optimization_commitment != [0; 32],
            IntentError::Mandate
        );
        let now = u64::try_from(now).map_err(|_| error!(IntentError::Expiry))?;
        let last = now
            .checked_add(lifetime as u64)
            .ok_or(IntentError::IntentArithmetic)?;
        require!(
            now < self.expiry_unix_seconds && self.expiry_unix_seconds <= last,
            IntentError::Expiry
        );
        let mut any = false;
        for a in self.assets {
            require!(
                a.funding <= MAX_AMOUNT
                    && a.min_output <= a.max_output
                    && a.max_output <= MAX_AMOUNT
                    && (1..=crate::oracle::MAX_PRICE).contains(&a.funding_reference_price),
                IntentError::Mandate
            );
            any |= a.funding > 0;
        }
        require!(any, IntentError::EmptySlice);
        Ok(())
    }
    pub fn canonical_bytes(
        &self,
        policy: &Policy,
        policy_hash: [u8; 32],
        owner: Pubkey,
        recipients: [Pubkey; 3],
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(605);
        bytes.extend_from_slice(b"CFLINT01");
        bytes.push(self.schema_version);
        for value in [
            policy.genesis,
            policy.program_id.to_bytes(),
            policy.config_address.to_bytes(),
            policy_hash,
            owner.to_bytes(),
        ] {
            bytes.extend_from_slice(&value);
        }
        bytes.extend_from_slice(&self.nonce.to_le_bytes());
        bytes.extend_from_slice(&self.expiry_unix_seconds.to_le_bytes());
        bytes.extend_from_slice(&self.optimization_commitment);
        bytes.push(3);
        for (i, a) in self.assets.iter().enumerate() {
            let asset = policy.assets[i];
            bytes.extend_from_slice(asset.mint.as_ref());
            bytes.extend_from_slice(asset.token_program.as_ref());
            bytes.push(asset.decimals);
            bytes.extend_from_slice(recipients[i].as_ref());
            for value in [
                a.funding,
                a.min_output,
                a.max_output,
                a.funding_reference_price,
            ] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        bytes
    }
    pub fn mandate_hash(
        &self,
        policy: &Policy,
        policy_hash: [u8; 32],
        owner: Pubkey,
        recipients: [Pubkey; 3],
    ) -> [u8; 32] {
        hash(&self.canonical_bytes(policy, policy_hash, owner, recipients)).to_bytes()
    }
}

#[account]
#[derive(InitSpace)]
pub struct OwnerState {
    pub config: Pubkey,
    pub owner: Pubkey,
    pub next_nonce: u64,
    pub active_intent: Option<Pubkey>,
    pub bump: u8,
}
impl OwnerState {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum IntentStatus {
    Funded,
    Settled,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Intent {
    pub config: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub expiry_unix_seconds: u64,
    pub policy_hash: [u8; 32],
    pub mandate_hash: [u8; 32],
    pub optimization_commitment: [u8; 32],
    pub assets: [FundAsset; 3],
    pub recipients: [Pubkey; 3],
    pub vaults: [Pubkey; 3],
    pub booked_claims: [u64; 3],
    pub initial_surplus: [u64; 3],
    pub status: IntentStatus,
    pub bump: u8,
}
impl Intent {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;
}

pub use crate::CrossflowError as IntentError;

#[cfg(test)]
mod tests {
    use super::*;
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
    #[test]
    fn canonical_mandate_matches_frozen_cross_language_vector() {
        let policy = Policy::parse(&crate::config::tests::golden_policy_bytes()).unwrap();
        let request = FundRequest {
            schema_version: 1,
            expected_policy_hash: [
                127, 238, 58, 32, 110, 212, 250, 243, 207, 151, 192, 221, 132, 66, 34, 133, 177,
                122, 179, 201, 19, 132, 19, 25, 229, 94, 47, 63, 140, 197, 88, 160,
            ],
            nonce: 0,
            expiry_unix_seconds: 1800630900,
            optimization_commitment: [
                172, 175, 142, 188, 151, 165, 94, 38, 48, 250, 130, 180, 71, 249, 70, 237, 95, 252,
                87, 132, 70, 211, 149, 120, 208, 49, 244, 227, 28, 12, 0, 16,
            ],
            assets: [
                FundAsset {
                    funding: 1000000000,
                    min_output: 200000000,
                    max_output: 2000000000,
                    funding_reference_price: 1000000,
                },
                FundAsset {
                    funding: 5000000,
                    min_output: 0,
                    max_output: 15000000,
                    funding_reference_price: 100000000,
                },
                FundAsset {
                    funding: 2000000,
                    min_output: 0,
                    max_output: 10000000,
                    funding_reference_price: 150000000,
                },
            ],
        };
        let owner = Pubkey::new_from_array([
            215, 90, 152, 1, 130, 177, 10, 183, 213, 75, 254, 211, 201, 100, 7, 58, 14, 225, 114,
            243, 218, 166, 35, 37, 175, 2, 26, 104, 247, 7, 81, 26,
        ]);
        let recipients = [
            Pubkey::new_from_array([
                96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96,
                96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96,
            ]),
            Pubkey::new_from_array([
                97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97,
                97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97,
            ]),
            Pubkey::new_from_array([
                98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98,
                98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98,
            ]),
        ];
        let bytes =
            request.canonical_bytes(&policy, request.expected_policy_hash, owner, recipients);
        assert_eq!(bytes.len(), 605);
        assert_eq!(
            request.mandate_hash(&policy, request.expected_policy_hash, owner, recipients),
            [
                152, 228, 96, 46, 168, 78, 58, 59, 30, 196, 171, 69, 48, 133, 225, 120, 125, 119,
                223, 163, 56, 245, 138, 221, 134, 207, 227, 212, 65, 163, 132, 246
            ]
        );
    }
    #[test]
    fn fixed_funding_body_and_bounds() {
        let r = request();
        let mut body = Vec::new();
        r.serialize(&mut body).unwrap();
        assert_eq!(body.len(), 177);
        assert!(r.validate([9; 32], 1000, 900).is_ok());
        assert!(r.validate([9; 32], 1001, 900).is_err());
        let mut r = request();
        r.expiry_unix_seconds = 1901;
        assert!(r.validate([9; 32], 1000, 900).is_err());
        r.expiry_unix_seconds = 1900;
        assert!(r.validate([9; 32], 1000, 900).is_ok());
        r.assets[1].funding = MAX_AMOUNT + 1;
        assert!(r.validate([9; 32], 1000, 900).is_err());
    }
    #[test]
    fn zero_funding_and_policy_substitution_reject() {
        let mut r = request();
        assert!(r.validate([0; 32], 1000, 900).is_err());
        for a in &mut r.assets {
            a.funding = 0;
        }
        assert!(r.validate([9; 32], 1000, 900).is_err());
    }
}
