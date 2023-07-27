use core::result::Result;

use ckb_std::high_level::load_script_hash;
use ckb_std::{ckb_constants::Source, high_level::load_script};

use crate::celltype::{cell_type_iter, CellType};
use crate::error::Error;
use crate::utils::{extract_accumulated_rate, extract_receipt_data, extract_token_amount};
use utils::extract_unused_capacity;

pub fn main() -> Result<(), Error> {
    if load_script()?.args().len() > 0 {
        return Err(Error::ScriptArgs);
    }

    let ickb_script_hash: [u8; 32] = load_script_hash()?;

    let out_ickb = check_output(ickb_script_hash)?;
    let (in_ickb, in_receipts_ickb, in_deposits_ickb) = check_input(ickb_script_hash)?;

    // Receipts are not transferrable, only convertible.
    // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
    if in_ickb + in_receipts_ickb >= out_ickb + in_deposits_ickb {
        Ok(())
    } else {
        Err(Error::Amount)
    }
}

fn check_input(ickb_script_hash: [u8; 32]) -> Result<(u128, u128, u128), Error> {
    let mut total_ickb_amount = 0;
    let mut total_receipts_ickb = 0;
    let mut total_deposits_ickb = 0;

    for maybe_cell_info in cell_type_iter(Source::Input, ickb_script_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        match cell_type {
            CellType::Deposit => {
                let deposit_amount = extract_unused_capacity(index, source)?;

                // Convert to iCKB and apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_deposits_ickb += deposit_to_ickb(index, source, deposit_amount)?;
            }
            CellType::Receipt => {
                let (receipt_count, receipt_amount) = extract_receipt_data(index, source)?;

                // Convert to iCKB and apply a 10% fee for the amount exceeding the soft iCKB cap per deposit.
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_receipts_ickb +=
                    u128::from(receipt_count) * deposit_to_ickb(index, source, receipt_amount)?;
            }
            CellType::Token => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_ickb_amount += extract_token_amount(index, source)?;
            }
            CellType::Unknown => (),
        }
    }

    return Ok((total_ickb_amount, total_receipts_ickb, total_deposits_ickb));
}

const CKB_DECIMALS: u64 = 8;
const CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 82 * 10 ^ CKB_DECIMALS; // 82 CKB
const ICKB_DECIMALS: u128 = 8; // CKB and iCKB have the same number of decimals
const ICKB_SOFT_CAP_PER_DEPOSIT: u128 = 100_000 * 10 ^ ICKB_DECIMALS; // 100_000 iCKB.
const GENESIS_ACCUMULATED_RATE: u128 = 10 ^ 16; // Genesis block accumulated rate.

fn deposit_to_ickb(index: usize, source: Source, amount: u64) -> Result<u128, Error> {
    let amount = u128::from(amount);
    let ar_0 = GENESIS_ACCUMULATED_RATE;
    let ar_m = u128::from(extract_accumulated_rate(index, source)?);

    // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
    // Even more ar_0 <= ar_m, iCKB amounts will always be smaller than the CKB amounts they wrap.
    let ickb_amount = amount * ar_0 / ar_m;

    // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
    if ickb_amount > ICKB_SOFT_CAP_PER_DEPOSIT {
        return Ok(ickb_amount - (ickb_amount - ICKB_SOFT_CAP_PER_DEPOSIT) / 10);
    }

    return Ok(ickb_amount);
}

fn check_output(ickb_script_hash: [u8; 32]) -> Result<u128, Error> {
    let mut total_ickb_amount = 0;

    let (mut deposit_count, mut deposit_amount) = (0u64, 0u64);
    for maybe_cell_info in cell_type_iter(Source::Output, ickb_script_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        // A deposit must be followed by another equal deposit or their exact receipt.
        match (cell_type, deposit_count) {
            (CellType::Deposit, 0) => {
                let amount = extract_unused_capacity(index, source)?;
                if amount < CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT {
                    return Err(Error::DepositTooSmall);
                }
                (deposit_count, deposit_amount) = (1, amount);
            }
            (CellType::Deposit, ..) => {
                let amount = extract_unused_capacity(index, source)?;
                if deposit_amount == amount {
                    // Note on Overflow: even locking the total CKB supply in Deposit cells can't overflow this counter.
                    deposit_count += 1;
                } else {
                    return Err(Error::UnequalDeposit);
                }
            }
            (CellType::Receipt, 0) => {
                return Err(Error::NoDeposit);
            }
            (CellType::Receipt, ..) => {
                let (receipt_count, receipt_amount) = extract_receipt_data(index, source)?;
                if (receipt_count, receipt_amount) == (deposit_count, deposit_amount) {
                    (deposit_count, deposit_amount) = (0, 0);
                } else {
                    return Err(Error::ReceiptAmount);
                }
            }
            (.., 1..) => {
                return Err(Error::NoReceipt);
            }
            (CellType::Token, 0) => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_ickb_amount += extract_token_amount(index, source)?;
            }
            (CellType::Unknown, 0) => {}
        }
    }

    return Ok(total_ickb_amount);
}
