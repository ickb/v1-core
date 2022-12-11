use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    high_level::{load_cell_lock_hash, load_cell_type_hash},
    syscalls::SysError,
};

use crate::{
    error::Error,
    utils::{cell_data_is_8_zeroed_bytes, from_hex},
};

pub fn cell_type_iter(source: Source, owner_lock_hash: [u8; 32]) -> CellTypeIter {
    CellTypeIter {
        next_index: 0,
        source,
        owner_lock_hash,
    }
}

pub struct CellTypeIter {
    next_index: usize,
    source: Source,
    owner_lock_hash: [u8; 32],
}

pub enum CellType {
    Unknown,
    Deposit,
    Receipt,
    Token,
    Owner,
}

impl Iterator for CellTypeIter {
    type Item = Result<(usize, Source, CellType), Error>;

    // Iterates over the specified sources, returning the index and type of found iCKB cells.
    // Returns an error in case of preventable iCKB scripts misuse in output cells.
    fn next(&mut self) -> Option<Self::Item> {
        let index = self.next_index;
        let mut ok = |cell_type| { 
            self.next_index += 1;
            Some(Ok((index, self.source, cell_type)))
        };
        let err = |e| Some(Err(e));

        let (lock_script_type, type_script_type) = match (
            load_cell_lock_hash(index, self.source),
            load_cell_type_hash(index, self.source),
        ) {
            // No more cells.
            (Err(SysError::IndexOutOfBound), ..) => return None,
            // Unknown error.
            (Err(e), ..) | (.., Err(e)) => return err(Error::from(e)),
            // A new cell exists.
            (Ok(lock_script_hash), Ok(maybe_type_script_hash)) => {
                let script_type = |script_hash| script_type_(script_hash, self.owner_lock_hash);
                (
                    script_type(lock_script_hash),
                    maybe_type_script_hash.map_or(ScriptType::None, script_type),
                )
            }
        };

        if lock_script_type == ScriptType::DepositLock
        && type_script_type == ScriptType::NervosDaoType
        // This condition checks that's a deposit, not a withdrawal.
        && cell_data_is_8_zeroed_bytes(index, self.source)
        {
            return ok(CellType::Deposit);
        }

        if type_script_type == ScriptType::ReceiptType {
            return ok(CellType::Receipt);
        }

        if type_script_type == ScriptType::TokenType {
            return ok(CellType::Token);
        }

        if lock_script_type == ScriptType::OwnerLock 
        // Type script must be void.
        && type_script_type == ScriptType::None {
            return ok(CellType::Owner);
        }

        // Return no error if some iCKB scripts are misused in input cells, just not account for them. 
        // In this way the CKB locked in these malformed cells can be retrieved.
        if self.source == Source::Input {
            return ok(CellType::Unknown);
        }

        if lock_script_type == ScriptType::Unknown
        // Type script can be any between None, Unknown and NervosDaoType.
        && type_script_type <= ScriptType::NervosDaoType
        {
            return ok(CellType::Unknown);
        }

        // Prevent malformed output cells with iCKB scripts.
        err(Error::ScriptMisuse)
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum ScriptType {
    None,
    Unknown,
    NervosDaoType,
    DepositLock,
    ReceiptType,
    TokenType,
    OwnerLock,
}

//To be calculated ///////////////////////////////////////
const NERVOS_DAO_TYPE_HASH: [u8; 32] = from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2a");
const DEPOSIT_LOCK_HASH: [u8; 32] = from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2b");
const RECEIPT_TYPE_HASH: [u8; 32] = from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2c");
const TOKEN_TYPE_HASH: [u8; 32] = from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2d");

fn script_type_(script_hash: [u8; 32], owner_lock_hash: [u8; 32]) -> ScriptType {
    
    if script_hash == owner_lock_hash {
        return ScriptType::OwnerLock;
    }

    match script_hash {
        NERVOS_DAO_TYPE_HASH => ScriptType::NervosDaoType,
        DEPOSIT_LOCK_HASH => ScriptType::DepositLock,
        RECEIPT_TYPE_HASH => ScriptType::ReceiptType,
        TOKEN_TYPE_HASH => ScriptType::TokenType,
        _ => ScriptType::Unknown,
    }
}
