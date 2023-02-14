use core::result::Result;

use crate::error::Error;

use ckb_std::{ckb_constants::Source, ckb_types::prelude::*, high_level::*};

pub fn extract_token_amount(index: usize, source: Source) -> Result<u128, Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 16 {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; 16];
    buffer.copy_from_slice(&data[0..16]);
    let token_amount = u128::from_le_bytes(buffer);

    Ok(token_amount)
}

pub fn extract_receipt_data(index: usize, source: Source) -> Result<(u64, u64), Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < 8 {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; 8];

    // From the 7th byte to the 8th is stored in little endian the count of the contiguous deposits.
    buffer[0..2].copy_from_slice(&data[6..8]); // The last six bytes of the buffer are already zero.
    let receipt_count = u64::from_le_bytes(buffer);

    // From the 1th byte to the 6th is stored in little endian the amount of a single deposit.
    buffer[0..6].copy_from_slice(&data[0..6]); // The last two bytes of the buffer are already zero.
    let receipt_amount = u64::from_le_bytes(buffer);

    Ok((receipt_amount, receipt_count))
}

pub fn extract_unused_capacity(index: usize, source: Source) -> Result<u64, Error> {
    Ok(load_cell_capacity(index, source)? - load_cell_occupied_capacity(index, source)?)
}

pub fn extract_accumulated_rate(index: usize, source: Source) -> Result<u64, Error> {
    let dao_data = load_header(index, source)?.raw().dao();

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

fn u64_from(data: &[u8], begin: usize) -> Result<u64, Error> {
    let end = begin + 8;

    if data.len() < end {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(&data[begin..end]);
    let number = u64::from_le_bytes(buffer);

    Ok(number)
}

pub const fn from_hex(hex_string: &str) -> [u8; 32] {
    if hex_string.len() != 2 + 2 * 32
        || hex_string.as_bytes()[0] != ('0' as u8)
        || hex_string.as_bytes()[1] != ('x' as u8)
    {
        panic!("Invalid input hexadecimal string")
    }

    let mut result = [0u8; 32];
    let hb = hex_string.as_bytes();

    let mut i = 0;
    while i < 32 {
        result[i] = hex_value(hb[2 * i + 2]) * 16 + hex_value(hb[2 * i + 3]);

        i += 1;
    }

    return result;
}

const fn hex_value(hc: u8) -> u8 {
    const _0: u8 = '0' as u8;
    const _9: u8 = '9' as u8;
    const A: u8 = 'a' as u8;
    const F: u8 = 'f' as u8;
    match hc {
        _0..=_9 => hc - _0,
        A..=F => hc - A + 10,
        _ => panic!("Invalid input hexadecimal character"),
    }
}
