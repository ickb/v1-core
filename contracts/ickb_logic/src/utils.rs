use alloc::vec::Vec;
use core::{convert::TryInto, result::Result};

use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Unpack,
    high_level::{load_cell_data, load_header, load_input_out_point},
};

use utils::{u128_from, u64_from};

use crate::error::Error;

pub fn extract_token_amount(index: usize, source: Source) -> Result<u128, Error> {
    let data = load_cell_data(index, source)?;

    let token_amount = u128_from(&data, 0)?;

    Ok(token_amount)
}

const ZERO_TX_HASH: [u8; 32] = [0u8; 32];

pub fn extract_tx_hash(index: usize, source: Source) -> Result<[u8; 32], Error> {
    if source == Source::Output {
        return Ok(ZERO_TX_HASH);
    }

    Ok(load_input_out_point(index, source)?.tx_hash().unpack())
}

// Data layout in bytes
// {
const UNION_ID: usize = 4;
const DEPOSIT_AMOUNT: usize = 6;
const DEPOSIT_QUANTITY: usize = 1;
const OWNED_QUANTITY: usize = 1;
//  {
const TX_HASH: usize = 32;
//   const OWNED_QUANTITY: usize = 1;
//  }[] = 33 * load(UNION_ID);
// }

pub fn extract_receipt_data(
    index: usize,
    source: Source,
) -> Result<(u64, u8, Vec<([u8; 32], u64)>), Error> {
    let min_size = UNION_ID + DEPOSIT_AMOUNT + DEPOSIT_QUANTITY + OWNED_QUANTITY;
    let step_size = OWNED_QUANTITY + TX_HASH;

    let data = load_cell_data(index, source)?;
    if data.len() < min_size || (data.len() - min_size) % step_size != 0 {
        return Err(Error::Encoding);
    }
    let unspent_quantity = (data.len() - min_size) / step_size;

    // Data splitter
    let mut raw_data = data.as_slice();
    let mut load = |size: usize| {
        let field_data: &[u8];
        (field_data, raw_data) = raw_data.split_at(size);
        return field_data;
    };

    //Check that union id is indeed equal to unspent quantity
    if u32::from_le_bytes(load(UNION_ID).try_into().unwrap()) as usize != unspent_quantity {
        return Err(Error::InvalidUnionId);
    }

    // Stored in little endian is the amount of a single deposit
    let mut buffer = [0u8; 8];
    buffer[0..DEPOSIT_AMOUNT].copy_from_slice(load(DEPOSIT_AMOUNT)); // Last bytes of buffer already zero
    let receipt_deposit_amount = u64::from_le_bytes(buffer);

    // The quantity of the deposits
    let receipt_deposit_quantity = load(DEPOSIT_QUANTITY)[0];

    // Owned cells quantities
    let mut receipt_owned = Vec::with_capacity(1 + unspent_quantity);

    // The quantity of the current receipt owned cells excluding deposits
    let receipt_owned_quantity = u64::from(load(OWNED_QUANTITY)[0]);

    if receipt_owned_quantity > 0 {
        let receipt_tx_hash = extract_tx_hash(index, source)?;
        receipt_owned.push((receipt_tx_hash, receipt_owned_quantity));
    }

    for _ in 0..unspent_quantity {
        // Unspent owned cells transaction hashes
        let tx_hash: [u8; 32] = load(TX_HASH).try_into().unwrap();
        if tx_hash == ZERO_TX_HASH {
            return Err(Error::ZeroTxHash);
        }

        // Unspent owned cells quantities
        // Receipt owned quantity is a only positive numbers, so it is encoded subtracting 1 to avoid the zero value
        let receipt_owned_quantity = u64::from(load(OWNED_QUANTITY)[0]) + 1;

        receipt_owned.push((tx_hash, receipt_owned_quantity));
    }

    Ok((
        receipt_deposit_amount,
        receipt_deposit_quantity,
        receipt_owned,
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
