use anchor_lang::prelude::*;

declare_id!("CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh");

#[program]
pub mod crossflow {
    use super::*;

    // T04 schema/build marker only. Funding and settlement arrive in reviewed later tasks.
    pub fn schema_marker(_ctx: Context<SchemaMarker>) -> Result<()> {
        msg!("crossflow-schema-v1");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SchemaMarker {}
