use crate::error::Error;
use core::result::Result;
use utils::{u128_from, u64_from};

use ckb_std::{ckb_constants::Source, ckb_types::prelude::*, high_level::*};

pub fn extract_token_amount(index: usize, source: Source) -> Result<u128, Error> {
    let data = load_cell_data(index, source)?;

    let token_amount = u128_from(&data, 0)?;

    Ok(token_amount)
}

pub fn extract_receipt_data(index: usize, source: Source) -> Result<(u8, u8, u64), Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 8 {
        return Err(Error::Encoding);
    }

    // The first byte contains the count of the receipt owned cells excluding deposits.
    let receipt_owned_count = data[0];

    // The second byte contains the count of the deposits.
    let receipt_deposit_count = data[1];

    // From the 3th byte to the 8th is stored in little endian the amount of a single deposit.
    let mut buffer = [0u8; 8];
    buffer[0..6].copy_from_slice(&data[2..8]); // The last two bytes of the buffer are already zero.
    let receipt_deposit_amount = u64::from_le_bytes(buffer);

    Ok((
        receipt_owned_count,
        receipt_deposit_count,
        receipt_deposit_amount,
    ))
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
        Ok(d) => d == 0,
        Err(_) => false,
    }
}
