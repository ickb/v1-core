use core::result::Result;

use alloc::vec::Vec;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Unpack,
    high_level::{
        load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_input_out_point,
        load_script, load_script_hash, QueryIter,
    },
};

use crate::error::Error;

pub fn main() -> Result<(), Error> {
    if load_script()?.args().len() > 0 {
        return Err(Error::ScriptArgs);
    }

    let receipt_script_hash: [u8; 32] = load_script_hash()?;

    validate(receipt_script_hash, Source::Output)?;
    validate(receipt_script_hash, Source::Input)
}

// An included cell is a cell whose lock is this script with empty args
// A receipt is a cell whose type is this script with empty args
//
// For each receipt validate that:
// - included cells equal to receipt count
// - receipt count is bigger than zero
// - 0-n receipt in inputs
// - 0-1 receipt in outputs
fn validate(receipt_script_hash: [u8; 32], source: Source) -> Result<(), Error> {
    let load_tx_hash = if source == Source::Input {
        |index: usize| match load_input_out_point(index, Source::Input) {
            Ok(out_point) => Ok(out_point.tx_hash().unpack()),
            Err(err) => Err(err),
        }
    } else {
        |_: usize| {
            Ok([
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0,
            ])
        }
    };

    let mut tx_2_count_receipt = Vec::<([u8; 32], u64, u64)>::with_capacity(10);

    for (index, maybe_type_hash) in QueryIter::new(load_cell_type_hash, source).enumerate() {
        let is_receipt = maybe_type_hash.map_or(false, |h| h == receipt_script_hash);
        let is_included_cell = load_cell_lock_hash(index, source)? == receipt_script_hash;

        if !is_included_cell || !is_receipt {
            continue;
        }

        if is_included_cell && is_receipt {
            // A cell can't be both a receipt and an included cell
            return Err(Error::Encoding);
        }

        let tx_hash = load_tx_hash(index)?;

        let (position, count, receipt_count) =
            match tx_2_count_receipt.binary_search_by_key(&tx_hash, |&(th, _, _)| th) {
                Err(i) => {
                    tx_2_count_receipt.insert(i, (tx_hash, 0, 0));
                    (i, 0, 0)
                }
                Ok(i) => {
                    let (_, count, receipt_count) = tx_2_count_receipt[i];
                    (i, count, receipt_count)
                }
            };

        if is_included_cell {
            // Note on Overflow: even locking the total CKB supply in included cells can't overflow this counter.
            tx_2_count_receipt[position].1 = count + 1;
        }

        if is_receipt {
            if receipt_count > 0 {
                // Receipt already found
                return Err(Error::DuplicateReceipt);
            }

            let new_receipt_count = extract_receipt_data(index, source)?;
            if new_receipt_count == 0 {
                // No included cells
                return Err(Error::Encoding);
            }

            tx_2_count_receipt[position].2 = u64::from(new_receipt_count);
        }
    }

    for (_, count, receipt_count) in tx_2_count_receipt {
        if count != receipt_count {
            // Mismatch in cell count
            return Err(Error::CountMismatch);
        }
    }

    return Ok(());
}

fn extract_receipt_data(index: usize, source: Source) -> Result<u32, Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 4 {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; 4];

    // From the first byte to the fourth is stored in little endian the count of the included cells.
    buffer[0..4].copy_from_slice(&data[0..4]); // The last six bytes of the buffer are already zero.
    let receipt_count = u32::from_le_bytes(buffer);

    Ok(receipt_count)
}
