use core::{convert::TryInto, result::Result};

use ckb_std::{
    ckb_constants::Source,
    syscalls::{load_cell_data, SysError},
};

use crate::error::Error;

// Data layout in bytes
// {
const DEPOSIT_QUANTITY_SIZE: usize = 4;
const DEPOSIT_AMOUNT_SIZE: usize = 8;
// }

const RECEIPT_SIZE: usize = DEPOSIT_QUANTITY_SIZE + DEPOSIT_AMOUNT_SIZE;

pub fn extract_receipt_data(index: usize, source: Source) -> Result<(u32, u64), Error> {
    let mut data = [0u8; RECEIPT_SIZE];
    let mut raw_data = match load_cell_data(&mut data, 0, index, source) {
        Ok(RECEIPT_SIZE) | Err(SysError::LengthNotEnough(_)) => data.as_slice(),
        Ok(_) => return Err(Error::Encoding),
        Err(err) => return Err(Error::from(err)),
    };

    // Data splitter
    let mut load = |size: usize| {
        let field_data: &[u8];
        (field_data, raw_data) = raw_data.split_at(size);
        field_data
    };

    // The quantity of the deposits
    let deposit_quantity = u32::from_le_bytes(load(DEPOSIT_QUANTITY_SIZE).try_into().unwrap());

    // Stored in little endian is the amount of a single deposit
    let deposit_amount = u64::from_le_bytes(load(DEPOSIT_AMOUNT_SIZE).try_into().unwrap());

    Ok((deposit_quantity, deposit_amount))
}
