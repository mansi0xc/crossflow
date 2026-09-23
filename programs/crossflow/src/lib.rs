use anchor_lang::prelude::*;

pub mod config;
pub mod funding;
pub mod intent;
pub mod oracle;
use config::*;
use funding::*;
use intent::FundRequest;
use oracle::Observation;

declare_id!("CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh");

#[program]
pub mod crossflow {
    use super::*;

    pub fn schema_marker(_ctx: Context<SchemaMarker>) -> Result<()> {
        msg!("crossflow-schema-v1");
        Ok(())
    }
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        observations: [Observation; 3],
    ) -> Result<()> {
        config::initialize(ctx, observations)
    }
    pub fn publish_prices(
        ctx: Context<PublishPrices>,
        next_sequence: u64,
        observations: [Observation; 3],
    ) -> Result<()> {
        config::publish(ctx, next_sequence, observations)
    }
    pub fn create_and_fund(ctx: Context<CreateAndFund>, request: FundRequest) -> Result<()> {
        funding::create_and_fund(ctx, request)
    }
}

#[derive(Accounts)]
pub struct SchemaMarker {}

// Anchor emits one error table per program; keep module ranges stable and non-overlapping.
#[error_code]
pub enum CrossflowError {
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

    #[msg("Deployment manifest is disabled or absent")]
    DeploymentDisabled = 100,
    #[msg("Compiled deployment identity mismatch")]
    DeploymentIdentity,
    #[msg("Expected deployment initializer signature required")]
    Initializer,
    #[msg("Canonical policy is invalid or changed")]
    ConfigPolicy,
    #[msg("Residual routing is not enabled in T05")]
    RouteDisabled,

    #[msg("Mandate fields or policy hash are invalid")]
    Mandate = 200,
    #[msg("Intent expiry is not within the approved future lifetime")]
    Expiry,
    #[msg("Cannot fund an empty slice")]
    EmptySlice,
    #[msg("Owner nonce or active intent is invalid")]
    Nonce,
    #[msg("Checked amount or nonce arithmetic failed")]
    IntentArithmetic,

    #[msg("Funding is paused")]
    Paused = 300,
    #[msg("Owner must be a transaction-signing wallet")]
    Owner,
    #[msg("Only exact canonical top-level funding instructions are accepted")]
    Instruction,
    #[msg("Mint identity, decimals, supply authority or freeze policy is unsupported")]
    Mint,
    #[msg("Token account identity or program is invalid")]
    TokenIdentity,
    #[msg("Token delegate, close authority, native or frozen state is unsupported")]
    TokenState,
    #[msg("Insufficient selected slice funding")]
    InsufficientFunds,
    #[msg("Account roles must not alias")]
    Alias,
    #[msg("Actual funding token deltas did not match the mandate")]
    Delta,
}
