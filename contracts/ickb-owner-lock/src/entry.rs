use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, prelude::*},
    high_level::{load_script, load_script_hash},
};

use crate::celltype::{cell_type_iter, CellType};
use crate::error::Error;
use crate::utils::{
    extract_accumulated_rate, extract_receipt_data, extract_token_amount, extract_unused_capacity,
};

pub fn main() -> Result<(), Error> {
    let args: Bytes = load_script()?.args().unpack();
    if !args.is_empty() {
        return Err(Error::NotEmptyArgs);
    }

    let owner_hash = load_script_hash()?;

    let (out_ickb, out_public_owner_cells, out_has_deposits) = check_output(owner_hash)?;
    let (in_ickb, in_receipts_ickb, in_deposits_ickb, in_public_owner_cells) =
        check_input(owner_hash)?;

    // Public owner cell cannot be consumed without re-creating a new one in the outputs.
    // At maximum one public owner cell can be consumed by a transaction (prevents DoS).
    if in_public_owner_cells > 1 || in_public_owner_cells > out_public_owner_cells {
        return Err(Error::ScriptMisuse);
    }

    // Owner lock should be included only in governance transactions.
    if !out_has_deposits && in_receipts_ickb == 0 && in_deposits_ickb == 0 {
        return Err(Error::ScriptMisuse);
    }

    // Receipts are not transferrable, only convertible.
    // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
    if in_ickb + in_receipts_ickb >= out_ickb + in_deposits_ickb {
        Ok(())
    } else {
        Err(Error::Amount)
    }
}

fn check_input(owner_hash: [u8; 32]) -> Result<(u128, u128, u128, u64), Error> {
    let mut total_ickb_amount = 0;
    let mut total_receipts_ickb = 0;
    let mut total_deposits_ickb = 0;
    let mut total_public_owner_cells = 0;

    for maybe_cell_info in cell_type_iter(Source::Output, owner_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        match cell_type {
            CellType::Deposit => {
                let deposit_amount = extract_unused_capacity(index, source)?;

                // Convert to iCKB and apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_deposits_ickb += deposit_to_ickb(index, source, deposit_amount)?;
            }
            CellType::Receipt => {
                let (receipt_amount, receipt_count) = extract_receipt_data(index, source)?;

                // Convert to iCKB and apply a 10% fee for the amount exceeding the soft iCKB cap per deposit.
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_receipts_ickb +=
                    deposit_to_ickb(index, source, receipt_amount)? * u128::from(receipt_count);
            }
            CellType::Token => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_ickb_amount += extract_token_amount(index, source)?;
            }
            CellType::PublicOwner => {
                // Note on Overflow: even locking the total CKB supply in PublicOwner cells can't overflow this counter.
                total_public_owner_cells += 1;
            }
            CellType::Unknown => (),
        }
    }

    return Ok((
        total_ickb_amount,
        total_receipts_ickb,
        total_deposits_ickb,
        total_public_owner_cells,
    ));
}

const CKB_DECIMALS: u64 = 8;
const CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 82 * 10 ^ CKB_DECIMALS; // 82 CKB
const ICKB_DECIMALS: u128 = 8; // CKB and iCKB have the same number of decimals
const ICKB_SOFT_CAP_PER_DEPOSIT: u128 = 10_000 * 10 ^ ICKB_DECIMALS; // 10_000 iCKB.
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

fn check_output(owner_hash: [u8; 32]) -> Result<(u128, u64, bool), Error> {
    let mut total_ickb_amount = 0;
    let mut total_public_owner_cells = 0;
    let mut has_deposits = false;

    let (mut deposit_count, mut deposit_amount) = (0u64, 0u64);
    for maybe_cell_info in cell_type_iter(Source::Output, owner_hash) {
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
                let (receipt_amount, receipt_count) = extract_receipt_data(index, source)?;
                if (receipt_count, receipt_amount) == (deposit_count, deposit_amount) {
                    (deposit_count, deposit_amount) = (0, 0);
                    has_deposits = true;
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
            (CellType::PublicOwner, 0) => {
                // Note on Overflow: even locking the total CKB supply in PublicOwner cells can't overflow this counter.
                total_public_owner_cells += 1;
            }
            (CellType::Unknown, 0) => {}
        }
    }

    return Ok((total_ickb_amount, total_public_owner_cells, has_deposits));
}
