use core::{convert::TryInto, result::Result};

use ckb_std::{
    ckb_constants::Source,
    high_level::{load_cell_data, load_header},
};

use crate::{constants::DAO_DEPOSIT_DATA, error::Error};

pub fn extract_udt_amount(index: usize, source: Source) -> Result<u128, Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 128 {
        return Err(Error::Encoding);
    }

    let udt_amount = u128::from_le_bytes(data[0..128].try_into().unwrap());

    Ok(udt_amount)
}

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

pub fn extract_accumulated_rate(index: usize, source: Source) -> Result<u64, Error> {
    let d = load_header(index, source)?.raw().dao();
    let accumulated_rate = u64::from_le_bytes([
        u8::from(d.nth8()),
        u8::from(d.nth9()),
        u8::from(d.nth10()),
        u8::from(d.nth11()),
        u8::from(d.nth12()),
        u8::from(d.nth13()),
        u8::from(d.nth14()),
        u8::from(d.nth15()),
    ]);
    Ok(accumulated_rate)
}

pub fn is_deposit_cell(index: usize, source: Source) -> bool {
    load_cell_data(index, source)
        .map(|data| data.as_ref() == DAO_DEPOSIT_DATA)
        .unwrap_or(false)
}
