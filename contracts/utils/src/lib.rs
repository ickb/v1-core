#![no_std]
#![cfg_attr(not(test), no_main)]

use core::result::Result;

use ckb_std::ckb_types::{packed::Script, prelude::Entity};
use ckb_std::error::SysError;
use ckb_std::{ckb_constants::Source, high_level::*};

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

pub fn extract_unused_capacity(index: usize, source: Source) -> Result<u64, SysError> {
    Ok(load_cell_capacity(index, source)? - load_cell_occupied_capacity(index, source)?)
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
