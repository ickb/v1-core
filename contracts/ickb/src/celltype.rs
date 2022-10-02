use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        core::ScriptHashType,
        packed::{Byte32, Script},
        prelude::*,
    },
    high_level::load_cell,
    syscalls::SysError,
};

use crate::{
    error::Error,
    utils::{cell_data_has_8_zeroed_bytes, from_hex},
};

pub fn cell_type_iter(source: Source, ickb_code_hash: &Byte32) -> CellTypeIter {
    CellTypeIter {
        index: 0,
        source,
        ickb_code_hash,
    }
}

pub struct CellTypeIter<'a> {
    index: usize,
    source: Source,
    ickb_code_hash: &'a Byte32,
}

pub enum CellType {
    Unknown,
    Deposit,
    TokenAndReceipt,
}

impl Iterator for CellTypeIter<'_> {
    type Item = Result<(usize, Source, CellType), Error>;

    // Iterates over the specified sources, returning the index and type of found iCKB cells.
    // Returns an error in case of preventable iCKB script misuse as lock in output cells.
    fn next(&mut self) -> Option<Self::Item> {
        let is_ickb = |s: &Script| -> bool {
            s.code_hash().as_slice() == self.ickb_code_hash.as_slice()
                && u8::from(s.hash_type()) == 0
        };

        let index = self.index;

        let (has_ickb_type, has_nervos_dao_type, has_ickb_lock) =
            match load_cell(index, self.source) {
                // No more cells.
                Err(SysError::IndexOutOfBound) => return None,
                // Unknown error.
                Err(e) => return Some(Err(Error::from(e))),
                // A new cell exists.
                Ok(cell) => {
                    // Increment index to the next cell.
                    self.index += 1;

                    let maybe_script_type = cell.type_().to_opt();

                    (
                        maybe_script_type.as_ref().map_or(false, is_ickb),
                        maybe_script_type.as_ref().map_or(false, is_nervos_dao),
                        is_ickb(&cell.lock()),
                    )
                }
            };

        if has_ickb_lock
                && has_nervos_dao_type
                // This condition checks that's a deposit, not a withdrawal.
                && cell_data_has_8_zeroed_bytes(index, self.source)
        {
            return Some(Ok((index, self.source, CellType::Deposit)));
        }

        // Checks that there are no misuses of ickb as lock in output cells.
        if has_ickb_lock && self.source == Source::Output {
            // Roll-back the index increment.
            self.index = index;
            return Some(Err(Error::InvalidLock));
        }

        if has_ickb_type {
            return Some(Ok((index, self.source, CellType::TokenAndReceipt)));
        }

        return Some(Ok((index, self.source, CellType::Unknown)));
    }
}

// From https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#example
// > The following type script represents the Nervos DAO script on CKB mainnet:
// > {
// >   "code_hash": "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
// >   "args": "0x",
// >   "hash_type": "type"
// > }

const NERVOS_DAO_CODE_HASH: [u8; 32] =
    from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e");
const NERVOS_DAO_ARGS_LEN: usize = 0;
const NERVOS_DAO_HASH_TYPE: u8 = ScriptHashType::Type as u8;

fn is_nervos_dao(s: &Script) -> bool {
    s.code_hash().as_slice() == NERVOS_DAO_CODE_HASH.as_slice()
        && s.args().len() == NERVOS_DAO_ARGS_LEN
        && u8::from(s.hash_type()) == NERVOS_DAO_HASH_TYPE
}
