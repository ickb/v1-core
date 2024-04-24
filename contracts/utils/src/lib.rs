#![no_std]
extern crate alloc;

use core::result::Result;

use alloc::vec::Vec;
use ckb_std::{
    ckb_types::{
        packed::{Header, Script},
        prelude::Entity,
    },
    error::SysError,
    syscalls::{load_header, load_input_by_field},
    {
        ckb_constants::{InputField, Source},
        high_level::*,
    },
};

use blake2b_ref::Blake2bBuilder;

pub fn hash_script(script: &Script) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut blake2b = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    blake2b.update(script.as_slice());
    blake2b.finalize(&mut output);
    output
}

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

const AMOUNT: usize = 16;

pub fn extract_udt_cell_data(index: usize, source: Source) -> Result<(u128, Vec<u8>), SysError> {
    let data = load_cell_data(index, source)?;

    if data.len() < AMOUNT {
        return Err(SysError::Encoding);
    }

    let udt_amount = u128::from_le_bytes(data[..AMOUNT].try_into().unwrap());
    let extra_data = data[AMOUNT..].to_vec();
    Ok((udt_amount, extra_data))
}

pub fn extract_unused_capacity(index: usize, source: Source) -> Result<u64, SysError> {
    Ok(load_cell_capacity(index, source)? - load_cell_occupied_capacity(index, source)?)
}

const DAO_START: usize = 160;
const C: usize = 8;
const AR: usize = 8;

pub fn extract_accumulated_rate(index: usize, source: Source) -> Result<u64, SysError> {
    let mut h = [0u8; Header::TOTAL_SIZE];
    load_header(&mut h, 0, index, source)?;
    let ar = u64::from_le_bytes(h[DAO_START + C..DAO_START + C + AR].try_into().unwrap());
    Ok(ar)
}

const TX_HASH: usize = 32;
const INDEX: usize = 4;

pub fn extract_metapoint(index: usize, source: Source) -> Result<MetaPoint, SysError> {
    if source == Source::Output {
        return Ok(MetaPoint {
            tx_hash: None,
            index: i64::from(index as u32),
        });
    }

    let mut d = [0u8; TX_HASH + INDEX];
    load_input_by_field(&mut d, 0, index, source, InputField::OutPoint)?;
    Ok(MetaPoint {
        tx_hash: Some(d[..TX_HASH].try_into().unwrap()),
        index: u32::from_le_bytes(d[TX_HASH..TX_HASH + INDEX].try_into().unwrap()) as i64,
    })
}

// MetaPoint is an extension of OutPoint functionalities
#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy)]
pub struct MetaPoint {
    // tx_hash contains Some(tx_hash) if it's an input OutPoint, otherwise None
    pub tx_hash: Option<[u8; 32]>,
    // index has been extended from u32 to i64 to allow extended validation logic
    pub index: i64,
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
