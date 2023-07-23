use core::result::Result;

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

fn validate(receipt_script_hash: [u8; 32], source: Source) -> Result<(), Error> {
    let mut included_cells_count = 0u64;
    for (index, maybe_type_hash) in QueryIter::new(load_cell_type_hash, source).enumerate() {
        // An included cell must be followed by another included cell or their receipt.

        let is_receipt = maybe_type_hash.map_or(false, |h| h == receipt_script_hash);
        let is_included_cell = load_cell_lock_hash(index, source)? == receipt_script_hash;

        if is_receipt {
            let receipt_count = extract_receipt_data(index, source)?;
            if included_cells_count > 0
                && receipt_count == included_cells_count
                //Do not allow for interlocked receipts
                && !is_included_cell
            {
                //Check that input outpoints are included correctly
                validate_out_points(index, source, receipt_count)?;

                included_cells_count = 0;
                continue;
            } else {
                return Err(Error::Encoding);
            }
        }

        if is_included_cell {
            // Note on Overflow: even locking the total CKB supply in included cells can't overflow this counter.
            included_cells_count += 1;
        }

        if included_cells_count > 0 && !is_receipt && !is_included_cell {
            return Err(Error::NoReceipt);
        }
    }

    return Ok(());
}

fn validate_out_points(index: usize, source: Source, receipt_count: u64) -> Result<(), Error> {
    if source != Source::Input {
        return Ok(());
    }

    let receipt_out_point = load_input_out_point(index, source)?;
    let receipt_out_point_tx_hash = receipt_out_point.tx_hash().unpack();
    let receipt_out_point_index: usize = receipt_out_point.index().unpack();

    for i in (index - receipt_count as usize)..index {
        let out_point = load_input_out_point(i, source)?;
        if receipt_out_point_tx_hash != out_point.tx_hash().unpack()
            || receipt_out_point_index - (index - i) != out_point.index().unpack()
        {
            return Err(Error::Encoding);
        }
    }

    Ok(())
}

fn extract_receipt_data(index: usize, source: Source) -> Result<u64, Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 2 {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; 8];

    // From the first byte to the second is stored in little endian the count of the contiguous cells.
    buffer[0..2].copy_from_slice(&data[0..2]); // The last six bytes of the buffer are already zero.
    let receipt_count = u64::from_le_bytes(buffer);

    Ok(receipt_count)
}
