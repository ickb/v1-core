use ckb_std::{
    ckb_constants::Source,
    high_level::load_cell_type_hash,
    syscalls::{load_cell_data, SysError},
};

use crate::{
    constants::{DAO_DEPOSIT_DATA, DAO_DEPOSIT_DATA_SIZE},
    DAO_HASH,
};

pub fn is_dao(index: usize, source: Source) -> Result<bool, SysError> {
    Ok(load_cell_type_hash(index, source)? == Some(DAO_HASH))
}

pub fn is_deposit_data(index: usize, source: Source) -> bool {
    let mut data = DAO_DEPOSIT_DATA.clone();
    match load_cell_data(&mut data, 0, index, source) {
        Ok(DAO_DEPOSIT_DATA_SIZE) => data == DAO_DEPOSIT_DATA,
        _ => false,
    }
}

pub fn is_withdrawal_request_data(index: usize, source: Source) -> bool {
    let mut data = DAO_DEPOSIT_DATA.clone();
    match load_cell_data(&mut data, 0, index, source) {
        Ok(DAO_DEPOSIT_DATA_SIZE) => data != DAO_DEPOSIT_DATA,
        _ => false,
    }
}
