use crate::error::Error;
use ckb_utils::{u128_from, u64_from};
use core::result::Result;

use ckb_std::{ckb_constants::Source, ckb_types::prelude::*, high_level::*};

pub fn extract_token_amount(index: usize, source: Source) -> Result<u128, Error> {
    let data = load_cell_data(index, source)?;

    let token_amount = u128_from(&data, 0)?;

    Ok(token_amount)
}

pub fn extract_receipt_data(index: usize, source: Source) -> Result<(u64, u64), Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 8 {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; 8];

    // From the first byte to the second is stored in little endian the count of the contiguous deposits.
    buffer[0..2].copy_from_slice(&data[0..2]); // The last six bytes of the buffer are already zero.
    let receipt_count = u64::from_le_bytes(buffer);

    // From the 3th byte to the 8th is stored in little endian the amount of a single deposit.
    buffer[0..6].copy_from_slice(&data[2..8]); // The last two bytes of the buffer are already zero.
    let receipt_amount = u64::from_le_bytes(buffer);

    Ok((receipt_count, receipt_amount))
}

pub fn extract_accumulated_rate(index: usize, source: Source) -> Result<u64, Error> {
    let dao_data = load_header(index, source)?.raw().dao().unpack();

    let accumulated_rate = u64_from(dao_data.as_slice(), 8)?;

    Ok(accumulated_rate)
}

pub fn cell_data_is_8_zeroed_bytes(index: usize, source: Source) -> bool {
    let data = match load_cell_data(index, source) {
        Ok(data) => data,
        Err(_) => return false,
    };

    if data.len() != 8 {
        return false;
    }

    match u64_from(data.as_slice(), 0) {
        Ok(d) => (d == 0),
        Err(_) => false,
    }
}
