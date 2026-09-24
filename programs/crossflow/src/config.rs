use crate::oracle::{self, FixtureSnapshot, Observation, OracleAsset, OracleBinding, OraclePolicy};
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

pub mod deployment {
    include!(concat!(env!("OUT_DIR"), "/deployment.rs"));
}

#[derive(Clone, Copy, Debug)]
pub struct AssetPolicy {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub feed_id: [u8; 32],
}

/// The committed residual-route identity. `kind = 0` disables routing entirely and requires
/// every identity to be zero; `kind = 1` admits exactly one venue program, one pool, that pool's
/// authority and that pool's canonical per-mint vaults. Nothing here is caller-supplied at
/// settlement time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoutePolicy {
    pub kind: u8,
    pub program: Pubkey,
    pub pool: Pubkey,
    pub pool_authority: Pubkey,
    pub vaults: [Pubkey; 3],
    pub max_legs: u8,
}

impl RoutePolicy {
    /// Not a `const`: `Pubkey::default()` is not const-evaluable.
    pub fn disabled() -> Self {
        Self {
            kind: 0,
            program: Pubkey::default(),
            pool: Pubkey::default(),
            pool_authority: Pubkey::default(),
            vaults: [Pubkey::default(); 3],
            max_legs: 0,
        }
    }
    pub fn enabled(&self) -> bool {
        self.kind == 1
    }
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub genesis: [u8; 32],
    pub program_id: Pubkey,
    pub config_address: Pubkey,
    pub version: u32,
    pub assets: [AssetPolicy; 3],
    pub oracle: OraclePolicy,
    pub route: RoutePolicy,
    pub max_intent_lifetime: u32,
    pub fixture_publisher: Pubkey,
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Reader<'a> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        let end = self
            .position
            .checked_add(N)
            .ok_or(ConfigError::ConfigPolicy)?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or(ConfigError::ConfigPolicy)?;
        let mut out = [0; N];
        out.copy_from_slice(slice);
        self.position = end;
        Ok(out)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take::<1>()?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn pubkey(&mut self) -> Result<Pubkey> {
        Ok(Pubkey::new_from_array(self.take()?))
    }
}

impl Policy {
    pub fn parse(bytes: &[u8; 652]) -> Result<Box<Self>> {
        let mut r = Reader { bytes, position: 0 };
        require!(r.take::<8>()? == *b"CFLCFG01", ConfigError::ConfigPolicy);
        let genesis = r.take()?;
        let program_id = r.pubkey()?;
        let config_address = r.pubkey()?;
        let version = r.u32()?;
        let mode = r.byte()?;
        let cash_index = r.byte()?;
        require!(version > 0 && r.byte()? == 3, ConfigError::ConfigPolicy);
        let mut assets = [AssetPolicy {
            mint: Pubkey::default(),
            token_program: Pubkey::default(),
            decimals: 0,
            feed_id: [0; 32],
        }; 3];
        for asset in &mut assets {
            *asset = AssetPolicy {
                mint: r.pubkey()?,
                token_program: r.pubkey()?,
                decimals: r.byte()?,
                feed_id: r.take()?,
            };
            require!(
                asset.token_program == anchor_spl::token::ID,
                ConfigError::ConfigPolicy
            );
        }
        // Route identities are derived, not trusted: an enabled route must name the venue's own
        // canonical vaults for the configured mints, so a policy cannot redirect proceeds.
        let route = RoutePolicy {
            kind: r.byte()?,
            program: r.pubkey()?,
            pool: r.pubkey()?,
            pool_authority: r.pubkey()?,
            vaults: [r.pubkey()?, r.pubkey()?, r.pubkey()?],
            max_legs: r.byte()?,
        };
        match route.kind {
            0 => require!(route == RoutePolicy::disabled(), ConfigError::RouteDisabled),
            1 => {
                require!(
                    route.program != Pubkey::default()
                        && route.pool != Pubkey::default()
                        && route.pool_authority != Pubkey::default()
                        && route.max_legs == 2,
                    ConfigError::RouteDisabled
                );
                for (i, asset) in assets.iter().enumerate() {
                    let (expected, _) = Pubkey::find_program_address(
                        &[route.pool.as_ref(), anchor_spl::token::ID.as_ref(), asset.mint.as_ref()],
                        &anchor_spl::associated_token::ID,
                    );
                    require!(route.vaults[i] == expected, ConfigError::RouteDisabled);
                }
            }
            _ => require!(false, ConfigError::RouteDisabled),
        }
        let max_age = r.u32()?;
        let max_future_skew = r.u32()?;
        let max_confidence_bps = r.u16()?;
        let max_reference_move_bps = r.u16()?;
        let max_value_loss_bps = r.u16()?;
        let max_cross_deviation_bps = r.u16()?;
        let max_external_deviation_bps = r.u16()?;
        let max_intent_lifetime = r.u32()?;
        let fixture_publisher = r.pubkey()?;
        require!(
            r.u16()? == 0 && r.position == 652,
            ConfigError::ConfigPolicy
        );
        require!(
            (1..=900).contains(&max_intent_lifetime) && genesis != [0; 32],
            ConfigError::ConfigPolicy
        );
        let result = Self {
            genesis,
            program_id,
            config_address,
            version,
            assets,
            oracle: OraclePolicy {
                mode,
                cash_index,
                max_age,
                max_future_skew,
                max_confidence_bps,
                max_reference_move_bps,
                max_value_loss_bps,
                max_cross_deviation_bps,
                max_external_deviation_bps,
            },
            route,
            max_intent_lifetime,
            fixture_publisher,
        };
        oracle::validate_binding(&result.binding(hash(bytes).to_bytes()))?;
        Ok(Box::new(result))
    }
    pub fn binding(&self, policy_hash: [u8; 32]) -> OracleBinding {
        OracleBinding {
            config: self.config_address,
            policy_hash,
            publisher: self.fixture_publisher,
            policy: self.oracle,
            assets: self.assets.map(|a| OracleAsset {
                mint: a.mint,
                feed_id: a.feed_id,
                decimals: a.decimals,
            }),
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub deployment_id: [u8; 32],
    pub genesis: [u8; 32],
    pub program_id: Pubkey,
    pub policy_hash: [u8; 32],
    pub policy_bytes: [u8; 652],
    pub admin: Pubkey,
    pub funding_paused: bool,
    pub settlement_paused: bool,
    pub outstanding_claim_intents: u64,
    pub bump: u8,
}
impl Config {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;
    pub fn validate(&self, address: Pubkey) -> Result<Box<Policy>> {
        require!(
            deployment::DEPLOYMENT_ENABLED,
            ConfigError::DeploymentDisabled
        );
        require!(
            self.deployment_id == deployment::DEPLOYMENT_ID
                && self.genesis == deployment::GENESIS
                && self.program_id == crate::ID
                && address == deployment::CONFIG_ADDRESS
                && self.admin != Pubkey::default(),
            ConfigError::DeploymentIdentity
        );
        let (expected, bump) =
            Pubkey::find_program_address(&[b"config", self.deployment_id.as_ref()], &crate::ID);
        require!(
            expected == address && bump == self.bump,
            ConfigError::DeploymentIdentity
        );
        require!(hash(&self.policy_bytes).to_bytes() == self.policy_hash, ConfigError::ConfigPolicy);
        let policy = Policy::parse(&self.policy_bytes)?;
        require!(
            policy.genesis == self.genesis
                && policy.program_id == self.program_id
                && policy.config_address == address
                && policy.version > 0,
            ConfigError::DeploymentIdentity
        );
        Ok(policy)
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut, constraint = deployment::DEPLOYMENT_ENABLED @ ConfigError::DeploymentDisabled,
        address = deployment::EXPECTED_INITIALIZER @ ConfigError::Initializer)]
    pub initializer: Signer<'info>,
    #[account(init, payer=initializer, space=Config::SPACE,
        seeds=[b"config",deployment::DEPLOYMENT_ID.as_ref()], bump,
        address=deployment::CONFIG_ADDRESS @ ConfigError::DeploymentIdentity)]
    pub config: Box<Account<'info, Config>>,
    #[account(init,payer=initializer,space=FixtureSnapshot::SPACE,seeds=[b"prices",config.key().as_ref()],bump)]
    pub prices: Box<Account<'info, FixtureSnapshot>>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<InitializeConfig>, observations: [Observation; 3]) -> Result<()> {
    require!(
        deployment::EXPECTED_INITIALIZER != Pubkey::default()
            && deployment::EXPECTED_INITIAL_ADMIN != Pubkey::default(),
        ConfigError::DeploymentIdentity
    );
    let cfg = &mut ctx.accounts.config;
    cfg.set_inner(Config {
        deployment_id: deployment::DEPLOYMENT_ID,
        genesis: deployment::GENESIS,
        program_id: crate::ID,
        policy_hash: deployment::INITIAL_POLICY_HASH,
        policy_bytes: deployment::INITIAL_POLICY_BYTES,
        admin: deployment::EXPECTED_INITIAL_ADMIN,
        funding_paused: false,
        settlement_paused: false,
        outstanding_claim_intents: 0,
        bump: ctx.bumps.config,
    });
    let policy = cfg.validate(cfg.key())?;
    let snapshot = oracle::initial_snapshot(
        &policy.binding(cfg.policy_hash),
        observations,
        Clock::get()?.unix_timestamp,
    )?;
    ctx.accounts.prices.set_inner(snapshot);
    emit!(ConfigurationInitialized {
        config: cfg.key(),
        policy_hash: cfg.policy_hash,
        publisher: policy.fixture_publisher
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PublishPrices<'info> {
    pub publisher: Signer<'info>,
    #[account(seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Oracle helper checks actual owner/PDA/discriminator/length before replacing bytes.
    #[account(mut)]
    pub prices: UncheckedAccount<'info>,
}

pub fn publish(
    ctx: Context<PublishPrices>,
    next_sequence: u64,
    observations: [Observation; 3],
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let policy = cfg.validate(cfg.key())?;
    oracle::publish_fixture(
        &ctx.accounts.prices.to_account_info(),
        &ctx.accounts.publisher.to_account_info(),
        &policy.binding(cfg.policy_hash),
        next_sequence,
        observations,
        Clock::get()?.unix_timestamp,
    )
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
}

pub fn set_pause(ctx: Context<SetPause>, pause_funding: bool, pause_settlement: bool) -> Result<()> {
    ctx.accounts.config.validate(ctx.accounts.config.key())?;
    require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.config.admin, ConfigError::Admin);
    ctx.accounts.config.funding_paused = pause_funding;
    ctx.accounts.config.settlement_paused = pause_settlement;
    emit!(PauseUpdated { config: ctx.accounts.config.key(), funding_paused: pause_funding, settlement_paused: pause_settlement });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub publisher: Signer<'info>,
    #[account(mut, seeds=[b"prices",config.key().as_ref()],bump)]
    pub prices: Box<Account<'info, FixtureSnapshot>>,
}

pub fn update_policy(ctx: Context<UpdatePolicy>, expected_version: u32, policy_bytes: [u8; 652], observations: [Observation; 3]) -> Result<()> {
    let current = ctx.accounts.config.validate(ctx.accounts.config.key())?;
    require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.config.admin, ConfigError::Admin);
    require!(ctx.accounts.config.outstanding_claim_intents == 0, ConfigError::ClaimsOutstanding);
    require!(current.version == expected_version, ConfigError::StaleVersion);
    require!(ctx.accounts.prices.to_account_info().data_len() == FixtureSnapshot::SPACE
        && ctx.accounts.prices.config == ctx.accounts.config.key()
        && ctx.accounts.prices.policy_hash == ctx.accounts.config.policy_hash
        && ctx.accounts.prices.publisher == current.fixture_publisher
        && ctx.accounts.prices.mode == 0
        && ctx.accounts.prices.sequence > 0, ConfigError::ConfigPolicy);
    let next_version = expected_version.checked_add(1).ok_or(ConfigError::ConfigPolicy)?;
    let next = Policy::parse(&policy_bytes)?;
    require!(next.version == next_version
        && next.genesis == ctx.accounts.config.genesis
        && next.program_id == crate::ID
        && next.config_address == ctx.accounts.config.key(), ConfigError::ConfigPolicy);
    require_keys_eq!(ctx.accounts.publisher.key(), next.fixture_publisher, ConfigError::Publisher);
    let next_hash = hash(&policy_bytes).to_bytes();
    let snapshot = oracle::initial_snapshot(&next.binding(next_hash), observations, Clock::get()?.unix_timestamp)?;
    ctx.accounts.config.policy_hash = next_hash;
    ctx.accounts.config.policy_bytes = policy_bytes;
    ctx.accounts.prices.set_inner(snapshot);
    emit!(PolicyUpdated { config: ctx.accounts.config.key(), version: next_version, policy_hash: ctx.accounts.config.policy_hash });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"config",config.deployment_id.as_ref()],bump=config.bump)]
    pub config: Box<Account<'info, Config>>,
}

pub fn update_admin(ctx: Context<UpdateAdmin>, expected_version: u32, next_admin: Pubkey) -> Result<()> {
    let policy = ctx.accounts.config.validate(ctx.accounts.config.key())?;
    require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.config.admin, ConfigError::Admin);
    require!(ctx.accounts.config.outstanding_claim_intents == 0, ConfigError::ClaimsOutstanding);
    require!(policy.version == expected_version, ConfigError::StaleVersion);
    require!(next_admin != Pubkey::default() && next_admin != crate::ID, ConfigError::Admin);
    ctx.accounts.config.admin = next_admin;
    emit!(AdminUpdated { config: ctx.accounts.config.key(), previous_admin: ctx.accounts.admin.key(), next_admin });
    Ok(())
}

#[event]
pub struct ConfigurationInitialized {
    pub config: Pubkey,
    pub policy_hash: [u8; 32],
    pub publisher: Pubkey,
}

#[event]
pub struct PauseUpdated { pub config: Pubkey, pub funding_paused: bool, pub settlement_paused: bool }
#[event]
pub struct PolicyUpdated { pub config: Pubkey, pub version: u32, pub policy_hash: [u8; 32] }
#[event]
pub struct AdminUpdated { pub config: Pubkey, pub previous_admin: Pubkey, pub next_admin: Pubkey }

pub use crate::CrossflowError as ConfigError;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn golden_policy_bytes() -> [u8; 652] {
        let hex="43464c4346473031ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab1111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222201000000000003313131313131313131313131313131313131313131313131313131313131313106ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9064141414141414141414141414141414141414141414141414141414141414141323232323232323232323232323232323232323232323232323232323232323206ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9064242424242424242424242424242424242424242424242424242424242424242333333333333333333333333333333333333333333333333333333333333333306ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a906434343434343434343434343434343434343434343434343434343434343434300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c000000020000006400f401c8006400c8008403000055555555555555555555555555555555555555555555555555555555555555550000";
        let mut bytes = [0; 652];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        bytes
    }
    #[test]
    fn canonical_policy_matches_frozen_hash_and_rejects_mutation() {
        let bytes = golden_policy_bytes();
        let p = Policy::parse(&bytes).unwrap();
        assert_eq!(p.version, 1);
        assert_eq!(p.oracle.cash_index, 0);
        assert_eq!(p.max_intent_lifetime, 900);
        assert_eq!(
            hash(&bytes).to_bytes(),
            [
                127, 238, 58, 32, 110, 212, 250, 243, 207, 151, 192, 221, 132, 66, 34, 133, 177,
                122, 179, 201, 19, 132, 19, 25, 229, 94, 47, 63, 140, 197, 88, 160
            ]
        );
        let mut invalid = bytes;
        invalid[108] = 1;
        assert!(Policy::parse(&invalid).is_err());
        invalid = bytes;
        invalid[402] = 1;
        assert!(Policy::parse(&invalid).is_err());
    }
    #[test]
    fn policy_schema_accepts_monotonic_rotation_version_without_changing_identity() {
        let mut bytes = golden_policy_bytes();
        bytes[104..108].copy_from_slice(&2u32.to_le_bytes());
        let policy = Policy::parse(&bytes).unwrap();
        assert_eq!(policy.version, 2);
        assert_eq!(policy.config_address, Pubkey::new_from_array(bytes[72..104].try_into().unwrap()));
        bytes[104..108].copy_from_slice(&0u32.to_le_bytes());
        assert!(Policy::parse(&bytes).is_err());
    }
    #[test]
    fn unsupported_policy_never_initializes() {
        assert!(Policy::parse(&[0; 652]).is_err());
    }
    #[test]
    fn absent_manifest_disables_public_initialization() {
        if !deployment::DEPLOYMENT_ENABLED {
            let cfg = Config {
                deployment_id: [0; 32],
                genesis: [0; 32],
                program_id: crate::ID,
                policy_hash: [0; 32],
                policy_bytes: [0; 652],
                admin: Pubkey::default(),
                funding_paused: false,
                settlement_paused: false,
                outstanding_claim_intents: 0,
                bump: 0,
            };
            assert!(cfg.validate(Pubkey::default()).is_err());
        }
    }
}
