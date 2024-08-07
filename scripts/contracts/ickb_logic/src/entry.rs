use alloc::collections::BTreeMap;
use core::result::Result;

use ckb_std::{ckb_constants::Source, high_level::load_script_hash};

use utils::{
    extract_accumulated_rate, extract_udt_cell_data, extract_unused_capacity, has_empty_args,
};

use crate::error::Error;
use crate::utils::extract_receipt_data;
use crate::{
    celltype::{cell_type_iter, CellType},
    constants::{
        CKB_MAXIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT, CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT,
        GENESIS_ACCUMULATED_RATE, ICKB_SOFT_CAP_PER_DEPOSIT,
    },
};

pub fn main() -> Result<(), Error> {
    if !has_empty_args()? {
        return Err(Error::NotEmptyArgs);
    }

    let ickb_logic_hash: [u8; 32] = load_script_hash()?;

    let out_udt_ickb = check_output(ickb_logic_hash)?;
    let (in_udt_ickb, in_receipts_ickb, in_deposits_ickb) = check_input(ickb_logic_hash)?;

    // Deposit receipts are not transferrable, only convertible
    // Note on Overflow: u64 quantities represented with u128, no overflow is possible
    if in_udt_ickb + in_receipts_ickb != out_udt_ickb + in_deposits_ickb {
        return Err(Error::AmountMismatch);
    }

    Ok(())
}

fn check_input(ickb_logic_hash: [u8; 32]) -> Result<(u128, u128, u128), Error> {
    let mut total_udt_ickb = 0;
    let mut total_receipts_ickb = 0;
    let mut total_deposits_ickb = 0;

    for maybe_cell_info in cell_type_iter(Source::Input, ickb_logic_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        match cell_type {
            CellType::Deposit => {
                let deposit_amount = extract_unused_capacity(index, source)?;

                // Convert to iCKB and apply a 10% discount for the amount exceeding the soft iCKB cap per deposit
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible
                total_deposits_ickb += deposit_to_ickb(index, source, deposit_amount)?;
            }
            CellType::Receipt => {
                let (deposit_quantity, deposit_amount) = extract_receipt_data(index, source)?;

                // Convert to iCKB and apply a 10% fee for the amount exceeding the soft iCKB cap per deposit
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible
                total_receipts_ickb +=
                    u128::from(deposit_quantity) * deposit_to_ickb(index, source, deposit_amount)?;
            }
            CellType::Udt => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible
                total_udt_ickb += extract_udt_cell_data(index, source)?.0;
            }
            CellType::Unknown => {}
        }
    }

    return Ok((total_udt_ickb, total_receipts_ickb, total_deposits_ickb));
}

fn deposit_to_ickb(index: usize, source: Source, amount: u64) -> Result<u128, Error> {
    let amount = u128::from(amount);
    let ar_0 = GENESIS_ACCUMULATED_RATE;
    let ar_m = u128::from(extract_accumulated_rate(index, source)?);

    // Note on Overflow: u64 quantities represented with u128, no overflow is possible
    // Even more ar_0 <= ar_m, iCKB amounts will always be smaller than the CKB amounts they wrap
    let ickb_amount = amount * ar_0 / ar_m;

    // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit
    if ickb_amount > ICKB_SOFT_CAP_PER_DEPOSIT {
        return Ok(ickb_amount - (ickb_amount - ICKB_SOFT_CAP_PER_DEPOSIT) / 10);
    }

    return Ok(ickb_amount);
}

fn check_output(ickb_logic_hash: [u8; 32]) -> Result<u128, Error> {
    let mut amount_2_accounting: BTreeMap<u64, Accounting> = BTreeMap::new();
    let default = Accounting {
        deposited: 0,
        receipted: 0,
    };

    let mut total_udt_ickb = 0;

    for maybe_cell_info in cell_type_iter(Source::Output, ickb_logic_hash) {
        let (index, source, cell_type) = maybe_cell_info?;

        match cell_type {
            CellType::Deposit => {
                let amount = extract_unused_capacity(index, source)?;
                if amount < CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT {
                    return Err(Error::DepositTooSmall);
                }
                if amount > CKB_MAXIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT {
                    return Err(Error::DepositTooBig);
                }

                let accounting = amount_2_accounting.entry(amount).or_insert(default);
                // Note on Overflow: even locking all CKB supply in deposits cannot overflow this counter
                accounting.deposited += 1;
            }
            CellType::Receipt => {
                let (deposit_quantity, deposit_amount) = extract_receipt_data(index, source)?;

                if deposit_quantity == 0 {
                    return Err(Error::EmptyReceipt);
                }

                let accounting = amount_2_accounting.entry(deposit_amount).or_insert(default);
                // Note on Overflow: even locking all CKB supply in receipts using Uint32 maximum
                // as deposit quantity cannot overflow this counter
                accounting.receipted += u128::from(deposit_quantity);
            }
            CellType::Udt => {
                // Note on Overflow: u64 quantities represented with u128, no overflow is possible
                total_udt_ickb += extract_udt_cell_data(index, source)?.0;
            }
            CellType::Unknown => {}
        }
    }

    if amount_2_accounting
        .into_values()
        .any(|a| a.deposited != a.receipted)
    {
        return Err(Error::ReceiptMismatch);
    }

    Ok(total_udt_ickb)
}

#[derive(Clone, Copy)]
struct Accounting {
    deposited: u128,
    receipted: u128,
}
