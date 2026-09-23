//! Labelled fixture reference policy. T05 must supply bindings from its authenticated config.
//! No public instruction creates/configures this account in T14; there is no first-caller admin.
use anchor_lang::prelude::*;

pub const MAX_AMOUNT: u64 = 1_000_000_000_000;
pub const MAX_PRICE: u64 = 1_000_000_000_000;
pub const FIXTURE_EXPONENT: i32 = -6;

#[derive(Clone, Copy, Debug)]
pub struct OraclePolicy {
    pub mode: u8,
    pub cash_index: u8,
    pub max_age: u32,
    pub max_future_skew: u32,
    pub max_confidence_bps: u16,
    pub max_reference_move_bps: u16,
    pub max_value_loss_bps: u16,
    pub max_cross_deviation_bps: u16,
    pub max_external_deviation_bps: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct OracleAsset {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
    pub decimals: u8,
}

/// Trusted *program-internal* input. T05 constructs it only from the validated config account,
/// never from instruction arguments. This type alone does not authenticate a config account.
#[derive(Clone, Debug)]
pub struct OracleBinding {
    pub config: Pubkey,
    pub policy_hash: [u8; 32],
    pub publisher: Pubkey,
    pub policy: OraclePolicy,
    pub assets: [OracleAsset; 3],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default)]
pub struct Observation {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
    pub price: u64,
    pub confidence: u64,
    pub exponent: i32,
    /// Zero means an absolute confidence amount in the same millionth-dollar units as price.
    pub confidence_kind: u8,
    pub underlying_observed_at: u64,
    pub published_at: u64,
    pub market_closed: bool,
}

#[account]
#[derive(Debug)]
pub struct FixtureSnapshot {
    pub config: Pubkey,
    pub policy_hash: [u8; 32],
    pub publisher: Pubkey,
    pub mode: u8,
    pub sequence: u64,
    pub observations: [Observation; 3],
}

impl FixtureSnapshot {
    // Anchor discriminator + three identities + mode + sequence + three fixed observations.
    pub const SPACE: usize = 8 + 32 * 3 + 1 + 8 + 3 * (32 + 32 + 8 + 8 + 4 + 1 + 8 + 8 + 1);
}

#[derive(Debug)]
pub struct VerifiedPrices {
    prices: [u64; 3],
    decimals: [u8; 3],
    policy: OraclePolicy,
    pub sequence: u64,
    pub policy_hash: [u8; 32],
}

#[error_code]
pub enum OracleError {
    #[msg("Only labelled fixture oracle mode is admitted")]
    UnsupportedMode,
    #[msg("Invalid oracle policy or identity binding")]
    Policy,
    #[msg("Wrong fixture account owner, PDA, config or policy hash")]
    Identity,
    #[msg("Configured fixture publisher signature required")]
    Publisher,
    #[msg("Wrong feed or asset identity")]
    Feed,
    #[msg("Wrong snapshot sequence or regressing update")]
    Sequence,
    #[msg("Unsupported price, exponent or confidence interpretation")]
    Price,
    #[msg("Observation is stale, in the future, or has invalid timestamp order")]
    Time,
    #[msg("Market is closed")]
    MarketClosed,
    #[msg("Confidence exceeds the approved bound")]
    Confidence,
    #[msg("Price moved beyond the funded reference bound")]
    ReferenceMove,
    #[msg("Trade stock/cash price is outside its approved band")]
    TradePrice,
    #[msg("Owner portfolio value loss exceeds the approved bound")]
    ValueLoss,
    #[msg("Amount or arithmetic bound exceeded")]
    Arithmetic,
}

fn mul(a: u128, b: u128) -> Result<u128> {
    a.checked_mul(b)
        .ok_or_else(|| error!(OracleError::Arithmetic))
}
fn add(a: u128, b: u128) -> Result<u128> {
    a.checked_add(b)
        .ok_or_else(|| error!(OracleError::Arithmetic))
}

pub fn validate_binding(b: &OracleBinding) -> Result<()> {
    let p = b.policy;
    require!(p.mode == 0, OracleError::UnsupportedMode);
    require!(
        p.cash_index < 3
            && (1..=60).contains(&p.max_age)
            && p.max_future_skew <= 2
            && p.max_confidence_bps <= 100
            && p.max_reference_move_bps <= 500
            && p.max_value_loss_bps <= 200
            && p.max_cross_deviation_bps <= 100
            && p.max_external_deviation_bps <= 200,
        OracleError::Policy
    );
    require!(
        b.config != Pubkey::default()
            && b.publisher != Pubkey::default()
            && b.policy_hash != [0; 32],
        OracleError::Policy
    );
    for (i, a) in b.assets.iter().enumerate() {
        require!(
            a.decimals <= 9 && a.mint != Pubkey::default() && a.feed_id != [0; 32],
            OracleError::Policy
        );
        if i > 0 {
            require!(
                b.assets[i - 1].mint.to_bytes() < a.mint.to_bytes(),
                OracleError::Policy
            );
        }
    }
    Ok(())
}

fn identity(b: &OracleBinding, s: &FixtureSnapshot) -> Result<()> {
    validate_binding(b)?;
    require!(s.mode == 0, OracleError::UnsupportedMode);
    require!(
        s.config == b.config && s.policy_hash == b.policy_hash,
        OracleError::Identity
    );
    require!(s.publisher == b.publisher, OracleError::Publisher);
    require!(s.sequence > 0, OracleError::Sequence);
    Ok(())
}

/// Pure policy validation. Runtime consumers must use read_fixture below for PDA/owner checks.
pub fn validate_snapshot(
    b: &OracleBinding,
    s: &FixtureSnapshot,
    expected_policy_hash: [u8; 32],
    expected_sequence: u64,
    now: i64,
) -> Result<VerifiedPrices> {
    validate_snapshot_inner(b, s, expected_policy_hash, expected_sequence, now, true)
}

fn validate_snapshot_inner(
    b: &OracleBinding,
    s: &FixtureSnapshot,
    expected_policy_hash: [u8; 32],
    expected_sequence: u64,
    now: i64,
    require_open: bool,
) -> Result<VerifiedPrices> {
    identity(b, s)?;
    require!(expected_policy_hash == b.policy_hash, OracleError::Identity);
    require!(s.sequence == expected_sequence, OracleError::Sequence);
    let now = u64::try_from(now).map_err(|_| error!(OracleError::Time))?;
    let future = now
        .checked_add(b.policy.max_future_skew as u64)
        .ok_or_else(|| error!(OracleError::Arithmetic))?;
    let mut prices = [0; 3];
    let mut decimals = [0; 3];
    for (i, o) in s.observations.iter().enumerate() {
        let asset = b.assets[i];
        require!(
            o.mint == asset.mint && o.feed_id == asset.feed_id,
            OracleError::Feed
        );
        require!(
            (1..=MAX_PRICE).contains(&o.price)
                && o.confidence <= o.price
                && o.exponent == FIXTURE_EXPONENT
                && o.confidence_kind == 0,
            OracleError::Price
        );
        if require_open {
            require!(!o.market_closed, OracleError::MarketClosed);
        }
        require!(
            o.underlying_observed_at <= o.published_at,
            OracleError::Time
        );
        for timestamp in [o.underlying_observed_at, o.published_at] {
            let last_valid = timestamp
                .checked_add(b.policy.max_age as u64)
                .ok_or_else(|| error!(OracleError::Arithmetic))?;
            require!(timestamp <= future && now <= last_valid, OracleError::Time);
        }
        require!(
            mul(o.confidence as u128, 10000)?
                <= mul(o.price as u128, b.policy.max_confidence_bps as u128)?,
            OracleError::Confidence
        );
        if i == b.policy.cash_index as usize {
            require!(
                o.price == 1_000_000 && o.confidence == 0,
                OracleError::Price
            );
        }
        prices[i] = o.price;
        decimals[i] = asset.decimals;
    }
    Ok(VerifiedPrices {
        prices,
        decimals,
        policy: b.policy,
        sequence: s.sequence,
        policy_hash: s.policy_hash,
    })
}

fn read_account(account: &AccountInfo, b: &OracleBinding) -> Result<FixtureSnapshot> {
    let (expected, _) = Pubkey::find_program_address(&[b"prices", b.config.as_ref()], &crate::ID);
    require!(
        *account.owner == crate::ID && *account.key == expected && !account.executable,
        OracleError::Identity
    );
    let data = account.try_borrow_data()?;
    require!(data.len() == FixtureSnapshot::SPACE, OracleError::Identity);
    FixtureSnapshot::try_deserialize(&mut &data[..]).map_err(Into::into)
}

/// Validates actual program ownership/PDA/discriminator before any price can affect funding/settlement.
pub fn read_fixture(
    account: &AccountInfo,
    b: &OracleBinding,
    expected_policy_hash: [u8; 32],
    expected_sequence: u64,
    now: i64,
) -> Result<VerifiedPrices> {
    let snapshot = read_account(account, b)?;
    validate_snapshot(b, &snapshot, expected_policy_hash, expected_sequence, now)
}

/// For T05's manifest-authorized config initialization only. It neither allocates an account
/// nor chooses a publisher/admin. The caller must already have authenticated that config.
pub fn initial_snapshot(
    b: &OracleBinding,
    observations: [Observation; 3],
    now: i64,
) -> Result<FixtureSnapshot> {
    let snapshot = FixtureSnapshot {
        config: b.config,
        policy_hash: b.policy_hash,
        publisher: b.publisher,
        mode: 0,
        sequence: 1,
        observations,
    };
    validate_snapshot_inner(b, &snapshot, b.policy_hash, 1, now, false)?;
    Ok(snapshot)
}

/// Runtime publication helper, deliberately not exposed as a self-service program instruction.
/// Sequence is exactly old+1 and both per-feed timestamps must not regress. Validation and
/// serialization complete before touching account data; a failed update preserves old bytes.
pub fn publish_fixture(
    account: &AccountInfo,
    publisher: &AccountInfo,
    b: &OracleBinding,
    next_sequence: u64,
    observations: [Observation; 3],
    now: i64,
) -> Result<()> {
    require!(
        publisher.is_signer && *publisher.key == b.publisher,
        OracleError::Publisher
    );
    require!(account.is_writable, OracleError::Identity);
    let previous = read_account(account, b)?;
    identity(b, &previous)?;
    let next = previous
        .sequence
        .checked_add(1)
        .ok_or_else(|| error!(OracleError::Sequence))?;
    require!(next_sequence == next, OracleError::Sequence);
    for (old, new) in previous.observations.iter().zip(observations.iter()) {
        require!(
            new.underlying_observed_at >= old.underlying_observed_at
                && new.published_at >= old.published_at,
            OracleError::Sequence
        );
    }
    let candidate = FixtureSnapshot {
        config: b.config,
        policy_hash: b.policy_hash,
        publisher: b.publisher,
        mode: 0,
        sequence: next,
        observations,
    };
    validate_snapshot_inner(b, &candidate, b.policy_hash, next, now, false)?;
    let mut encoded = Vec::with_capacity(FixtureSnapshot::SPACE);
    candidate.try_serialize(&mut encoded)?;
    require!(
        encoded.len() == FixtureSnapshot::SPACE,
        OracleError::Identity
    );
    account.try_borrow_mut_data()?.copy_from_slice(&encoded);
    Ok(())
}

impl VerifiedPrices {
    pub fn prices(&self) -> [u64; 3] {
        self.prices
    }
    fn value(&self, amount: u64, asset: usize, cap: u64) -> Result<u128> {
        require!(asset < 3 && amount <= cap, OracleError::Arithmetic);
        mul(
            mul(amount as u128, self.prices[asset] as u128)?,
            10u128.pow((9 - self.decimals[asset]) as u32),
        )
    }
    pub fn check_funding_reference(&self, reference: [u64; 3]) -> Result<()> {
        require!(reference == self.prices, OracleError::ReferenceMove);
        Ok(())
    }
    pub fn check_reference_move(&self, reference: [u64; 3]) -> Result<()> {
        for (p, p0) in self.prices.iter().zip(reference) {
            require!((1..=MAX_PRICE).contains(&p0), OracleError::Price);
            require!(
                mul(p.abs_diff(p0) as u128, 10000)?
                    <= mul(p0 as u128, self.policy.max_reference_move_bps as u128)?,
                OracleError::ReferenceMove
            );
        }
        Ok(())
    }
    fn trade(&self, stock: usize, quantity: u64, cash: u64, bps: u16, cap: u64) -> Result<()> {
        require!(
            stock < 3 && stock != self.policy.cash_index as usize && quantity > 0 && cash > 0,
            OracleError::TradePrice
        );
        let s = self.value(quantity, stock, cap)?;
        let k = mul(
            self.value(cash, self.policy.cash_index as usize, cap)?,
            10000,
        )?;
        require!(
            mul(s, (10000 - bps) as u128)? <= k && k <= mul(s, (10000 + bps) as u128)?,
            OracleError::TradePrice
        );
        Ok(())
    }
    pub fn check_cross(&self, stock: usize, q: u64, k: u64) -> Result<()> {
        self.trade(stock, q, k, self.policy.max_cross_deviation_bps, MAX_AMOUNT)
    }
    pub fn check_external_fill(&self, stock: usize, q: u64, k: u64) -> Result<()> {
        self.trade(
            stock,
            q,
            k,
            self.policy.max_external_deviation_bps,
            MAX_AMOUNT,
        )
    }
    pub fn check_external_total(&self, stock: usize, q: u64, k: u64) -> Result<()> {
        self.trade(
            stock,
            q,
            k,
            self.policy.max_external_deviation_bps,
            3 * MAX_AMOUNT,
        )
    }
    pub fn check_value_loss(&self, funding: [u64; 3], outputs: [u64; 3]) -> Result<()> {
        let mut f = 0;
        let mut o = 0;
        for a in 0..3 {
            f = add(f, self.value(funding[a], a, MAX_AMOUNT)?)?;
            o = add(o, self.value(outputs[a], a, MAX_AMOUNT)?)?;
        }
        require!(
            mul(o, 10000)? >= mul(f, (10000 - self.policy.max_value_loss_bps) as u128)?,
            OracleError::ValueLoss
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (OracleBinding, FixtureSnapshot) {
        let b = OracleBinding {
            config: Pubkey::new_from_array([9; 32]),
            policy_hash: [8; 32],
            publisher: Pubkey::new_from_array([7; 32]),
            policy: OraclePolicy {
                mode: 0,
                cash_index: 0,
                max_age: 60,
                max_future_skew: 2,
                max_confidence_bps: 100,
                max_reference_move_bps: 500,
                max_value_loss_bps: 200,
                max_cross_deviation_bps: 100,
                max_external_deviation_bps: 200,
            },
            assets: std::array::from_fn(|i| OracleAsset {
                mint: Pubkey::new_from_array([i as u8 + 1; 32]),
                feed_id: [i as u8 + 4; 32],
                decimals: 6,
            }),
        };
        let observations = std::array::from_fn(|i| Observation {
            mint: b.assets[i].mint,
            feed_id: b.assets[i].feed_id,
            price: [1_000_000, 10_000_000, 20_000_000][i],
            confidence: 0,
            exponent: -6,
            confidence_kind: 0,
            underlying_observed_at: 100,
            published_at: 100,
            market_closed: false,
        });
        let s = initial_snapshot(&b, observations, 100).unwrap();
        (b, s)
    }
    fn guard(b: &OracleBinding, s: &FixtureSnapshot, now: i64) -> Result<VerifiedPrices> {
        validate_snapshot(b, s, b.policy_hash, s.sequence, now)
    }
    #[test]
    fn time_confidence_and_identity_boundaries() {
        let (b, mut s) = fixture();
        assert!(guard(&b, &s, 160).is_ok());
        assert!(guard(&b, &s, 161).is_err());
        assert!(guard(&b, &s, -1).is_err());
        s.observations[1].published_at = 160;
        assert!(guard(&b, &s, 161).is_err());
        s.observations[1].underlying_observed_at = 162;
        s.observations[1].published_at = 162;
        assert!(guard(&b, &s, 160).is_ok());
        s.observations[1].published_at = 163;
        assert!(guard(&b, &s, 160).is_err());
        let (_, mut s) = fixture();
        s.observations[1].confidence = 100_000;
        assert!(guard(&b, &s, 100).is_ok());
        s.observations[1].confidence += 1;
        assert!(guard(&b, &s, 100).is_err());
        let (_, s) = fixture();
        assert!(validate_snapshot(&b, &s, [0; 32], 1, 100).is_err());
        assert!(validate_snapshot(&b, &s, b.policy_hash, 2, 100).is_err());
    }
    #[test]
    fn wrong_modes_feeds_interpretation_and_market_fail() {
        let (b, original) = fixture();
        for mutation in 0..7 {
            let mut s = original.clone();
            match mutation {
                0 => s.mode = 1,
                1 => s.publisher = Pubkey::default(),
                2 => s.observations[1].feed_id = [0; 32],
                3 => s.observations[1].exponent = -8,
                4 => s.observations[1].confidence_kind = 1,
                5 => s.observations[1].market_closed = true,
                _ => s.observations[0].price = 999_999,
            };
            assert!(guard(&b, &s, 100).is_err());
        }
    }
    #[test]
    fn per_trade_and_portfolio_guards_are_distinct() {
        let (b, s) = fixture();
        let p = guard(&b, &s, 100).unwrap();
        for (k, pass) in [
            (9_900_000, true),
            (9_899_999, false),
            (10_100_000, true),
            (10_100_001, false),
            (11_000_000, false),
        ] {
            assert_eq!(p.check_cross(1, 1_000_000, k).is_ok(), pass);
        }
        assert!(p.check_cross(1, 999_999, 10_100_000).is_err());
        assert!(p.check_cross(1, 1_000_001, 9_900_000).is_err());
        for (k, pass) in [
            (9_800_000, true),
            (9_799_999, false),
            (10_200_000, true),
            (10_200_001, false),
        ] {
            assert_eq!(p.check_external_fill(1, 1_000_000, k).is_ok(), pass);
        }
        assert!(p
            .check_value_loss([1_000_000_000, 0, 0], [989_000_000, 1_000_000, 0])
            .is_ok());
        assert!(p.check_cross(1, 1_000_000, 11_000_000).is_err());
        assert!(p.check_value_loss([10_000, 0, 0], [9800, 0, 0]).is_ok());
        assert!(p.check_value_loss([10_000, 0, 0], [9799, 0, 0]).is_err());
        assert!(p.check_cross(0, 1, 1).is_err());
        assert!(p.check_cross(3, 1, 1).is_err());
        assert!(p.check_cross(1, MAX_AMOUNT + 1, 1).is_err());
    }
    #[test]
    fn reference_movement_equality_and_one_unit() {
        let (b, mut s) = fixture();
        s.observations[1].price = 10_500_000;
        assert!(guard(&b, &s, 100)
            .unwrap()
            .check_reference_move([1_000_000, 10_000_000, 20_000_000])
            .is_ok());
        s.observations[1].price += 1;
        assert!(guard(&b, &s, 100)
            .unwrap()
            .check_reference_move([1_000_000, 10_000_000, 20_000_000])
            .is_err());
    }
    #[test]
    fn real_account_binding_and_update_signature_monotonicity() {
        let (b, s) = fixture();
        let (address, _) =
            Pubkey::find_program_address(&[b"prices", b.config.as_ref()], &crate::ID);
        let mut data = Vec::new();
        s.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), FixtureSnapshot::SPACE);
        let mut lamports = 1;
        let account = AccountInfo::new(
            &address,
            false,
            true,
            &mut lamports,
            &mut data,
            &crate::ID,
            false,
        );
        assert!(read_fixture(&account, &b, b.policy_hash, 1, 100).is_ok());
        let mut signer_lamports = 1;
        let mut signer_data = [];
        let system = Pubkey::default();
        let unsigned = AccountInfo::new(
            &b.publisher,
            false,
            false,
            &mut signer_lamports,
            &mut signer_data,
            &system,
            false,
        );
        assert!(publish_fixture(&account, &unsigned, &b, 2, s.observations, 100).is_err());
        drop(unsigned);
        let signer = AccountInfo::new(
            &b.publisher,
            true,
            false,
            &mut signer_lamports,
            &mut signer_data,
            &system,
            false,
        );
        let original = account.try_borrow_data().unwrap().to_vec();
        assert!(publish_fixture(&account, &signer, &b, 1, s.observations, 100).is_err());
        let mut regressed = s.observations;
        regressed[1].underlying_observed_at = 99;
        assert!(publish_fixture(&account, &signer, &b, 2, regressed, 100).is_err());
        assert_eq!(account.try_borrow_data().unwrap().to_vec(), original);
        let mut closed = s.observations;
        closed[1].market_closed = true;
        publish_fixture(&account, &signer, &b, 2, closed, 100).unwrap();
        assert!(read_fixture(&account, &b, b.policy_hash, 2, 100).is_err());
        publish_fixture(&account, &signer, &b, 3, s.observations, 100).unwrap();
        assert!(read_fixture(&account, &b, b.policy_hash, 3, 100).is_ok());
        let wrong_config = OracleBinding {
            config: Pubkey::new_from_array([20; 32]),
            ..b
        };
        assert!(read_fixture(&account, &wrong_config, wrong_config.policy_hash, 2, 100).is_err());
    }
    fn assert_account_identity_rejection(
        wrong_owner: bool,
        wrong_key: bool,
        corrupt_discriminator: bool,
    ) {
        let (binding, snapshot) = fixture();
        let (expected_address, _) =
            Pubkey::find_program_address(&[b"prices", binding.config.as_ref()], &crate::ID);
        let mut data = Vec::new();
        snapshot.try_serialize(&mut data).unwrap();
        // The same serialized content succeeds under the actual expected owner/PDA.
        let mut valid_data = data.clone();
        let mut valid_lamports = 1;
        let valid = AccountInfo::new(
            &expected_address,
            false,
            true,
            &mut valid_lamports,
            &mut valid_data,
            &crate::ID,
            false,
        );
        assert!(read_fixture(&valid, &binding, binding.policy_hash, 1, 100).is_ok());
        if corrupt_discriminator {
            data[0] ^= 0xff;
        }
        let before = data.clone();
        let address = if wrong_key {
            Pubkey::new_from_array([42; 32])
        } else {
            expected_address
        };
        let owner = if wrong_owner {
            Pubkey::default()
        } else {
            crate::ID
        };
        let mut lamports = 1;
        let account = AccountInfo::new(
            &address,
            false,
            true,
            &mut lamports,
            &mut data,
            &owner,
            false,
        );
        assert!(read_fixture(&account, &binding, binding.policy_hash, 1, 100).is_err());
        assert_eq!(account.try_borrow_data().unwrap().to_vec(), before);
        let mut signer_lamports = 1;
        let mut signer_data = [];
        let system = Pubkey::default();
        let signer = AccountInfo::new(
            &binding.publisher,
            true,
            false,
            &mut signer_lamports,
            &mut signer_data,
            &system,
            false,
        );
        // A valid publisher signature cannot make a substituted/corrupt account writable.
        assert!(
            publish_fixture(&account, &signer, &binding, 2, snapshot.observations, 100).is_err()
        );
        assert_eq!(account.try_borrow_data().unwrap().to_vec(), before);
    }

    #[test]
    fn wrong_program_owner_rejects_read_and_publish_without_mutation() {
        assert_account_identity_rejection(true, false, false);
    }

    #[test]
    fn wrong_snapshot_pda_rejects_read_and_publish_without_mutation() {
        assert_account_identity_rejection(false, true, false);
    }

    #[test]
    fn corrupt_discriminator_rejects_read_and_publish_without_mutation() {
        assert_account_identity_rejection(false, false, true);
    }
}
