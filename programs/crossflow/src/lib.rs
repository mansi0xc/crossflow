use anchor_lang::prelude::*;

pub mod config;
pub mod assets;
pub mod funding;
pub mod intent;
pub mod math;
pub mod oracle;
pub mod recovery;
pub mod settlement;
use config::*;
use funding::*;
use intent::{FundRequest, ThinSettleRequest};
use oracle::Observation;
use recovery::{CancelIntent, CloseIntent, RecoverClosedVault, WithdrawAsset};
pub(crate) use recovery::{__client_accounts_cancel_intent, __client_accounts_close_intent, __client_accounts_recover_closed_vault, __client_accounts_withdraw_asset};
use settlement::SettleThin;
pub(crate) use settlement::__client_accounts_settle_thin;

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
    pub fn set_pause(ctx: Context<SetPause>, pause_funding: bool, pause_settlement: bool) -> Result<()> {
        config::set_pause(ctx, pause_funding, pause_settlement)
    }
    pub fn update_policy(ctx: Context<UpdatePolicy>, expected_version: u32, policy_bytes: [u8; 652], observations: [Observation; 3]) -> Result<()> {
        config::update_policy(ctx, expected_version, policy_bytes, observations)
    }
    pub fn update_admin(ctx: Context<UpdateAdmin>, expected_version: u32, next_admin: Pubkey) -> Result<()> {
        config::update_admin(ctx, expected_version, next_admin)
    }
    pub fn create_and_fund(ctx: Context<CreateAndFund>, request: FundRequest) -> Result<()> {
        funding::create_and_fund(ctx, request)
    }
    pub fn settle_thin(ctx: Context<SettleThin>, request: ThinSettleRequest) -> Result<()> {
        settlement::settle_thin(ctx, request)
    }
    pub fn cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
        recovery::cancel_intent(ctx)
    }
    pub fn withdraw_asset(ctx: Context<WithdrawAsset>, asset_index: u8) -> Result<()> {
        recovery::withdraw_asset(ctx, asset_index)
    }
    pub fn recover_closed_vault(ctx: Context<RecoverClosedVault>, nonce: u64) -> Result<()> {
        recovery::recover_closed_vault(ctx, nonce)
    }
    pub fn close_intent(ctx: Context<CloseIntent>) -> Result<()> {
        recovery::close_intent(ctx)
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
    #[msg("Registered config admin signature required")]
    Admin,
    #[msg("Expected configuration version is stale")]
    StaleVersion,
    #[msg("Outstanding escrow claims prevent policy/admin rotation")]
    ClaimsOutstanding,

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

    #[msg("Raw amount or aggregate exceeds the admitted bound")]
    Amount = 500,
    #[msg("Arithmetic overflow or non-conserving allocation")]
    MathArithmetic,
    #[msg("An external participant would receive no output")]
    ZeroOutput,
    #[msg("Duplicate owner identity in an allocation")]
    DuplicateOwner,

    #[msg("Intent is expired, not funded, or violates the thin settlement rules")]
    Settle = 400,
    #[msg("Final output is outside its owner-approved raw bounds")]
    Output,
    #[msg("Snapshot sequence differs from the exact validated snapshot")]
    SnapshotSequence,
    #[msg("No claim is available for this asset")]
    NothingToWithdraw,
    #[msg("Only the funded owner can cancel or recover this intent")]
    RecoveryAuthority,
    #[msg("Intent has not reached a recoverable terminal state")]
    RecoveryStatus,
    #[msg("All claims and vault balances must be empty before close")]
    ClaimsRemain,
}
