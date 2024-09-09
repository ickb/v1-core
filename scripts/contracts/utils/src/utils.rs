use core::result::Result;

use ckb_std::{
    ckb_constants::{InputField, Source},
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_lock, load_cell_occupied_capacity, load_script, QueryIter,
    },
    syscalls::{load_cell_data, load_header, load_input_by_field},
};

use crate::constants::UDT_SIZE;

pub fn has_empty_args() -> Result<bool, SysError> {
    let s = load_script()?;
    let code_hash = s.code_hash();
    let hash_type = s.hash_type();
    let args = s.args();

    //The following check covers:
    // - Input lock args
    // - Input type args
    // - Output type args
    if !args.is_empty() {
        return Ok(false);
    }

    //Check that Output lock args are empty
    if QueryIter::new(load_cell_lock, Source::Output)
        .any(|s| code_hash == s.code_hash() && hash_type == s.hash_type() && args != s.args())
    {
        return Ok(false);
    }

    Ok(true)
}

pub fn extract_udt_amount(index: usize, source: Source) -> Result<u128, SysError> {
    let mut data = [0u8; UDT_SIZE];
    match load_cell_data(&mut data, 0, index, source) {
        Ok(UDT_SIZE) | Err(SysError::LengthNotEnough(_)) => Ok(u128::from_le_bytes(data)),
        Ok(_) => Err(SysError::Encoding),
        Err(err) => Err(err),
    }
}

pub fn extract_unused_capacity(index: usize, source: Source) -> Result<u64, SysError> {
    Ok(load_cell_capacity(index, source)? - load_cell_occupied_capacity(index, source)?)
}

const AR_OFFSET: usize = 160 + 8;
const AR_SIZE: usize = 8;

pub fn extract_accumulated_rate(index: usize, source: Source) -> Result<u64, SysError> {
    let mut data = [0u8; AR_SIZE];
    match load_header(&mut data, AR_OFFSET, index, source) {
        Ok(AR_SIZE) | Err(SysError::LengthNotEnough(_)) => Ok(u64::from_le_bytes(data)),
        Ok(_) => Err(SysError::Encoding),
        Err(err) => Err(err),
    }
}

const TX_HASH_SIZE: usize = 32;
const INDEX_SIZE: usize = 4;
const OUT_POINT_SIZE: usize = TX_HASH_SIZE + INDEX_SIZE;

pub fn extract_metapoint(index: usize, source: Source) -> Result<MetaPoint, SysError> {
    if source == Source::Output {
        return Ok(MetaPoint {
            tx_hash: None,
            index: i64::from(index as u32),
        });
    }

    let mut d = [0u8; OUT_POINT_SIZE];
    match load_input_by_field(&mut d, 0, index, source, InputField::OutPoint) {
        Ok(OUT_POINT_SIZE) => Ok(MetaPoint {
            tx_hash: Some(d[..TX_HASH_SIZE].try_into().unwrap()),
            index: i64::from(u32::from_le_bytes(d[TX_HASH_SIZE..].try_into().unwrap())),
        }),
        Ok(_) => Err(SysError::Encoding),
        Err(err) => Err(err),
    }
}

// MetaPoint is an extension of OutPoint functionalities
#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy, Debug)]
pub struct MetaPoint {
    // tx_hash contains Some(tx_hash) if it's an input OutPoint, otherwise None
    pub tx_hash: Option<[u8; 32]>,
    // index has been extended from u32 to i64 to allow extended validation logic
    pub index: i64,
}
