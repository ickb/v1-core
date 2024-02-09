use alloc::vec::Vec;
use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    high_level::{load_script, load_script_hash},
};

use utils::extract_unused_capacity;

use crate::celltype::{cell_type_iter, CellType};
use crate::error::Error;
use crate::owned::OwnedValidator;
use crate::utils::{
    extract_accumulated_rate, extract_receipt_data, extract_token_amount, extract_tx_hash,
};

pub fn main() -> Result<(), Error> {
    if load_script()?.args().len() > 0 {
        return Err(Error::ScriptArgs);
    }

    let ickb_script_hash: [u8; 32] = load_script_hash()?;

    let (out_ickb, out_unspent_receipted) = check_output(ickb_script_hash)?;
    let (in_ickb, in_receipts_ickb, in_deposits_ickb, in_unspent_receipted) =
        check_input(ickb_script_hash)?;

    // Deposit receipts are not transferrable, only convertible.
    // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
    if in_ickb + in_receipts_ickb < out_ickb + in_deposits_ickb {
        return Err(Error::SudtAmount);
    }

    // Check unspent owned
    if in_unspent_receipted != out_unspent_receipted {
        return Err(Error::UnspentMismatch);
    }

    Ok(())
}

fn check_input(
    ickb_script_hash: [u8; 32],
) -> Result<(u128, u128, u128, Vec<([u8; 32], u64)>), Error> {
    let mut total_ickb_amount = 0;
    let mut total_receipts_ickb = 0;
    let mut total_deposits_ickb = 0;

    let mut owned_validator = OwnedValidator::new();

    for maybe_cell_info in cell_type_iter(Source::Input, ickb_script_hash) {
        let (index, source, cell_type, is_owned) = maybe_cell_info?;

        if is_owned {
            owned_validator.add_owned(extract_tx_hash(index, source)?, 1)?;
        }

        match cell_type {
            CellType::Deposit => {
                let deposit_amount = extract_unused_capacity(index, source)?;

                // Convert to iCKB and apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_deposits_ickb += deposit_to_ickb(index, source, deposit_amount)?;
            }
            CellType::Receipt => {
                let (receipt_deposit_amount, receipt_deposit_quantity, receipt_owned) =
                    extract_receipt_data(index, source)?;

                // Convert to iCKB and apply a 10% fee for the amount exceeding the soft iCKB cap per deposit.
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_receipts_ickb += u128::from(receipt_deposit_quantity)
                    * deposit_to_ickb(index, source, receipt_deposit_amount)?;

                for (tx_hash, receipted) in receipt_owned {
                    owned_validator.add_receipted(tx_hash, u64::from(receipted))?;
                }
            }
            CellType::Token => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_ickb_amount += extract_token_amount(index, source)?;
            }
            CellType::Unknown => {}
        }
    }

    let unspent = owned_validator.unspent_receipted()?;

    return Ok((
        total_ickb_amount,
        total_receipts_ickb,
        total_deposits_ickb,
        unspent,
    ));
}

const CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 82 * 100_000_000; // 82 CKB
const ICKB_SOFT_CAP_PER_DEPOSIT: u128 = 100_000 * 100_000_000; // 100_000 iCKB.
const GENESIS_ACCUMULATED_RATE: u128 = 100_000_000 * 100_000_000; // 10^16 Genesis block accumulated rate.

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

fn check_output(ickb_script_hash: [u8; 32]) -> Result<(u128, Vec<([u8; 32], u64)>), Error> {
    let (mut owned_quantity, mut deposit_quantity, mut deposit_amount) = (0u64, 0u64, 0u64);
    let mut maybe_receipt_index: Option<usize> = None;

    let mut total_ickb_amount = 0;

    for maybe_cell_info in cell_type_iter(Source::Output, ickb_script_hash) {
        let (index, source, cell_type, is_owned) = maybe_cell_info?;

        if is_owned {
            // Note on Overflow: even locking the total CKB supply in cells can't overflow this counter.
            owned_quantity += 1;
        }

        match cell_type {
            CellType::Deposit => {
                let amount = extract_unused_capacity(index, source)?;
                if amount < CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT {
                    return Err(Error::DepositTooSmall);
                }

                if deposit_quantity == 0 {
                    (deposit_quantity, deposit_amount) = (1, amount);
                } else if deposit_amount == amount {
                    // Note on Overflow: even locking the total CKB supply in Deposits can't overflow this counter.
                    deposit_quantity += 1;
                } else {
                    return Err(Error::UnequalDeposit);
                }
            }
            CellType::Receipt => {
                if maybe_receipt_index != None {
                    return Err(Error::TwoReceipts);
                }
                maybe_receipt_index = Some(index);
            }
            CellType::Token => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
                total_ickb_amount += extract_token_amount(index, source)?;
            }
            CellType::Unknown => {}
        }
    }

    match maybe_receipt_index {
        Some(index) => {
            let (receipt_deposit_amount, receipt_deposit_quantity, receipt_owned) =
                extract_receipt_data(index, Source::Output)?;

            if receipt_deposit_quantity == 0 && receipt_owned.len() == 0 {
                return Err(Error::EmptyReceipt);
            }

            if deposit_quantity != receipt_deposit_quantity as u64 {
                return Err(Error::ReceiptQuantity);
            }

            if deposit_amount != receipt_deposit_amount {
                return Err(Error::ReceiptAmount);
            }

            let mut owned_validator = OwnedValidator::new();
            owned_validator.add_owned(extract_tx_hash(0, Source::Output)?, owned_quantity)?;
            for (tx_hash, receipted) in receipt_owned {
                owned_validator.add_receipted(tx_hash, u64::from(receipted))?;
            }
            let unspent = owned_validator.unspent_receipted()?;

            return Ok((total_ickb_amount, unspent));
        }
        None => {
            if owned_quantity > 0 || deposit_quantity > 0 {
                return Err(Error::NoReceipt);
            }

            return Ok((total_ickb_amount, Vec::with_capacity(0)));
        }
    };
}
