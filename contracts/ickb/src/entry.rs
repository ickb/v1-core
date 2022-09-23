use core::{cmp::min, result::Result};

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, packed::Byte32, prelude::*},
    high_level::load_script,
};

use crate::celltype::{cell_type_iter, CellType};
use crate::error::Error;
use crate::utils::{extract_accumulated_rate, extract_ickb_data, extract_unused_capacity};

pub fn main() -> Result<(), Error> {
    let script = load_script()?;
    let args: Bytes = script.args().unpack();

    if !args.is_empty() {
        return Err(Error::NotEmptyArgs);
    }

    let code_hash = script.code_hash();

    let out_ickb = check_output(&code_hash)?;
    let (in_ickb, in_receipts_ickb, in_deposits_ickb) = check_input(&code_hash)?;

    // Receipts are not transferrable, having this as strict equality prevents accidental burns of receipts.
    if in_ickb + in_receipts_ickb == out_ickb + in_deposits_ickb {
        Ok(())
    } else {
        Err(Error::Amount)
    }
}

const ICKB_CAP_PER_RECEIPT: u64 = 10_000 * 100_000_000; // 10000 iCKB in shannons.

fn check_input(ickb_code_hash: &Byte32) -> Result<(u64, u64, u64), Error> {
    let mut total_ickb_amount = 0;
    let mut total_receipts_ickb = 0;
    let mut total_deposits_ickb = 0;

    for maybe_cell_info in cell_type_iter(Source::Output, &ickb_code_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        match cell_type {
            CellType::Deposit => {
                total_deposits_ickb +=
                    ckb_to_ickb(index, source, extract_unused_capacity(index, source)?)?;
            }
            CellType::TokenAndReceipt => {
                let (token_amount, receipt_amount) = extract_ickb_data(index, source)?;

                total_ickb_amount += token_amount;

                // Cap max ickb equivalent per receipt.
                total_receipts_ickb += min(
                    ckb_to_ickb(index, source, receipt_amount)?,
                    ICKB_CAP_PER_RECEIPT,
                );
            }
            CellType::Unknown => (),
        }
    }

    return Ok((total_ickb_amount, total_receipts_ickb, total_deposits_ickb));
}

const GENESIS_ACCUMULATED_RATE: u128 = 10_000_000_000_000_000; // Genesis block accumulated rate.

fn ckb_to_ickb(index: usize, source: Source, amount: u64) -> Result<u64, Error> {
    Ok((u128::from(amount) * GENESIS_ACCUMULATED_RATE
        / u128::from(extract_accumulated_rate(index, source)?)) as u64)
}

fn check_output(ickb_code_hash: &Byte32) -> Result<u64, Error> {
    let mut total_ickb_amount = 0;

    let mut maybe_deposit_amount: Option<u64> = None;
    for maybe_cell_info in cell_type_iter(Source::Output, &ickb_code_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        // A deposit must be followed by its exact receipt.
        match (maybe_deposit_amount, cell_type) {
            (None, CellType::Deposit) => {
                maybe_deposit_amount = Some(extract_unused_capacity(index, source)?);
            }
            (Some(deposit_amount), CellType::TokenAndReceipt) => {
                let (token_amount, receipt_amount) = extract_ickb_data(index, source)?;

                // Having this as strict check prevents accidental burns of receipts amounts.
                if receipt_amount == deposit_amount {
                    maybe_deposit_amount = None;
                } else {
                    return Err(Error::ReceiptAmount);
                }

                total_ickb_amount += token_amount;
            }
            (Some(_), _) => return Err(Error::NoReceipt),
            (None, CellType::TokenAndReceipt) => return Err(Error::NoDeposit),
            (None, CellType::Unknown) => (),
        }
    }

    return Ok(total_ickb_amount);
}
