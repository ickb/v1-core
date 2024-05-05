use core::{convert::TryInto, result::Result};

use ckb_std::{ckb_constants::Source, high_level::load_cell_data};

use crate::{constants::DAO_DEPOSIT_DATA, error::Error};

// Data layout in bytes
// {
const UNION_ID: usize = 4;
const DEPOSIT_QUANTITY: usize = 4;
const DEPOSIT_AMOUNT: usize = 8;
// }

pub fn extract_receipt_data(index: usize, source: Source) -> Result<(u32, u64), Error> {
    let data = load_cell_data(index, source)?;
    if data.len() != UNION_ID + DEPOSIT_QUANTITY + DEPOSIT_AMOUNT {
        return Err(Error::Encoding);
    }

    // Data splitter
    let mut raw_data = data.as_slice();
    let mut load = |size: usize| {
        let field_data: &[u8];
        (field_data, raw_data) = raw_data.split_at(size);
        return field_data;
    };

    //Check that union id is indeed zero
    if u32::from_le_bytes(load(UNION_ID).try_into().unwrap()) != 0 {
        return Err(Error::InvalidUnionId);
    }

    // The quantity of the deposits
    let deposit_quantity = u32::from_le_bytes(load(DEPOSIT_QUANTITY).try_into().unwrap());

    // Stored in little endian is the amount of a single deposit
    let deposit_amount = u64::from_le_bytes(load(DEPOSIT_AMOUNT).try_into().unwrap());

    Ok((deposit_quantity, deposit_amount))
}

pub fn is_deposit_cell(index: usize, source: Source) -> bool {
    load_cell_data(index, source)
        .map(|data| data.as_ref() == DAO_DEPOSIT_DATA)
        .unwrap_or(false)
}
