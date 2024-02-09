use alloc::vec::Vec;
use core::result::Result;

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

enum Base {
    DepositAmount = 0,
    DepositQuantity,
    OwnedQuantity,
}
const BASE_LENGTHS: [usize; 3] = [6, 1, 1];

enum Unspent {
    TxHash = 0,
    OwnedQuantity,
}
const UNSPENT_LENGTHS: [usize; 2] = [32, 1];
const ZERO_TX_HASH: [u8; 32] = [0u8; 32];

pub fn extract_tx_hash(index: usize, source: Source) -> Result<[u8; 32], Error> {
    if source == Source::Output {
        return Ok(ZERO_TX_HASH);
    }

    Ok(load_input_out_point(index, source)?.tx_hash().unpack())
}

pub fn extract_receipt_data(
    index: usize,
    source: Source,
) -> Result<(u64, u8, Vec<([u8; 32], u64)>), Error> {
    let min_len: usize = BASE_LENGTHS.iter().sum();
    let step_len: usize = UNSPENT_LENGTHS.iter().sum();

    let raw_data = load_cell_data(index, source)?;
    if raw_data.len() < min_len || (raw_data.len() - min_len) % step_len != 0 {
        return Err(Error::Encoding);
    }
    let unspent_quantity = (raw_data.len() - min_len) / step_len;

    let mut data: [&[u8]; BASE_LENGTHS.len()] = Default::default();
    let mut x0: usize = 0;
    for (index, length) in BASE_LENGTHS.iter().enumerate() {
        let x1 = x0 + length;
        data[index] = &raw_data[x0..x1];
        x0 = x1;
    }

    // Stored in little endian is the amount of a single deposit.
    let mut buffer = [0u8; 8];
    // The last bytes of the buffer are already zero.
    buffer[0..BASE_LENGTHS[Base::DepositAmount as usize]]
        .copy_from_slice(data[Base::DepositAmount as usize]);
    let receipt_deposit_amount = u64::from_le_bytes(buffer);

    // The quantity of the deposits.
    let receipt_deposit_quantity = data[Base::DepositQuantity as usize][0];

    // The quantity of the current receipt owned cells excluding deposits.
    let receipt_owned_quantity = u64::from(data[Base::OwnedQuantity as usize][0]);

    // Owned cells quantities
    let mut receipt_owned = Vec::with_capacity(1 + unspent_quantity);

    if receipt_owned_quantity > 0 {
        let receipt_tx_hash = extract_tx_hash(index, source)?;
        receipt_owned.push((receipt_tx_hash, receipt_owned_quantity));
    }

    while x0 < raw_data.len() {
        let x1 = x0 + UNSPENT_LENGTHS[Unspent::TxHash as usize];
        let x2 = x1 + UNSPENT_LENGTHS[Unspent::OwnedQuantity as usize];

        let tx_hash: [u8; 32] = raw_data[x0..x1].try_into().unwrap();
        if tx_hash == ZERO_TX_HASH {
            return Err(Error::ZeroTxHash);
        }

        // Receipt owned quantity is a only positive numbers, so it is encoded subtracting 1 to avoid the zero value.
        let receipt_owned_quantity = u64::from(raw_data[x1]) + 1;

        receipt_owned.push((tx_hash, receipt_owned_quantity));

        x0 = x2;
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
