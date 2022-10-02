use core::result::Result;

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

fn check_input(ickb_code_hash: &Byte32) -> Result<(u64, u64, u64), Error> {
    let mut total_ickb_amount = 0;
    let mut total_receipts_ickb = 0;
    let mut total_deposits_ickb = 0;

    for maybe_cell_info in cell_type_iter(Source::Output, &ickb_code_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        match cell_type {
            CellType::Deposit => {
                let deposit_amount = extract_unused_capacity(index, source)?;

                // Convert to iCKB and apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
                total_deposits_ickb += deposit_to_ickb(index, source, deposit_amount)?;
            }
            CellType::TokenAndReceipt => {
                let (token_amount, receipt_amount, receipt_count) =
                    extract_ickb_data(index, source)?;

                total_ickb_amount += token_amount;

                // Convert to iCKB and apply a 10% fee for the amount exceeding the soft iCKB cap per deposit.
                total_receipts_ickb +=
                    deposit_to_ickb(index, source, receipt_amount)? * (receipt_count as u64);
            }
            CellType::Unknown => (),
        }
    }

    return Ok((total_ickb_amount, total_receipts_ickb, total_deposits_ickb));
}

const GENESIS_ACCUMULATED_RATE: u128 = 10_000_000_000_000_000; // Genesis block accumulated rate.
const ICKB_SOFT_CAP_PER_DEPOSIT: u64 = 10_000 * 100_000_000; // 10000 iCKB in shannons.

fn deposit_to_ickb(index: usize, source: Source, amount: u64) -> Result<u64, Error> {
    let ickb_amount = (u128::from(amount) * GENESIS_ACCUMULATED_RATE
        / u128::from(extract_accumulated_rate(index, source)?)) as u64;

    // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
    if ickb_amount > ICKB_SOFT_CAP_PER_DEPOSIT {
        return Ok(ickb_amount - (ickb_amount - ICKB_SOFT_CAP_PER_DEPOSIT) / 10);
    }

    return Ok(ickb_amount);
}

fn check_output(ickb_code_hash: &Byte32) -> Result<u64, Error> {
    let mut total_ickb_amount = 0;

    let (mut deposit_count, mut deposit_amount) = (0u8, 0u64);
    for maybe_cell_info in cell_type_iter(Source::Output, &ickb_code_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        // A deposit must be followed by another equal deposit or their exact receipt.
        match cell_type {
            CellType::Deposit => {
                let amount = extract_unused_capacity(index, source)?;

                if deposit_count == 0 {
                    (deposit_count, deposit_amount) = (1, amount);
                } else if deposit_count == u8::MAX {
                    return Err(Error::DepositCountOverflow);
                } else if deposit_amount == amount {
                    deposit_count += 1;
                } else {
                    return Err(Error::UnequalDeposit);
                }
            }
            CellType::TokenAndReceipt => {
                let (token_amount, receipt_amount, receipt_count) =
                    extract_ickb_data(index, source)?;

                // Having this as strict check prevents accidental burns of receipts amounts.
                if (receipt_count, receipt_amount) == (deposit_count, deposit_amount) {
                    (deposit_count, deposit_amount) = (0, 0);
                } else {
                    return Err(Error::ReceiptAmount);
                }

                total_ickb_amount += token_amount;
            }
            CellType::Unknown => {
                if deposit_count > 0 {
                    return Err(Error::NoReceipt);
                }
            }
        }
    }

    return Ok(total_ickb_amount);
}
