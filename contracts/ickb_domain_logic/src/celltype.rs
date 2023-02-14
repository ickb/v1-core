use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{core::ScriptHashType, packed::Script, prelude::*},
    high_level::{load_cell_lock, load_cell_type},
    syscalls::SysError,
};

use crate::{
    error::Error,
    utils::{cell_data_is_8_zeroed_bytes, from_hex},
};

pub fn cell_type_iter(source: Source, ickb_code_hash: [u8; 32]) -> CellTypeIter {
    CellTypeIter {
        next_index: 0,
        source,
        ickb_code_hash,
    }
}

pub struct CellTypeIter {
    next_index: usize,
    source: Source,
    ickb_code_hash: [u8; 32],
}

pub enum CellType {
    Unknown,
    Deposit,
    Receipt,
    Token,
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
            load_cell_lock(index, self.source),
            load_cell_type(index, self.source),
        ) {
            // No more cells.
            (Err(SysError::IndexOutOfBound), ..) => return None,
            // Unknown error.
            (Err(e), ..) | (.., Err(e)) => return err(Error::from(e)),
            // A new cell exists.
            (Ok(lock_script), Ok(maybe_type_script)) => {
                let script_type = |script| script_type_(script, self.ickb_code_hash);
                (
                    script_type(&lock_script),
                    maybe_type_script
                        .as_ref()
                        .map_or(ScriptType::None, script_type),
                )
            }
        };

        if lock_script_type == ScriptType::ICKBScript {
            if type_script_type == ScriptType::NervosDaoType
            // This condition checks that's a deposit, not a withdrawal.
            && cell_data_is_8_zeroed_bytes(index, self.source)
            {
                return ok(CellType::Deposit);
            }

            // Other valid cells with iCKB Script as Lock
            // Keep ScriptType::None as valid use case? /////////////////////////////////////////////////
            if type_script_type == ScriptType::None || type_script_type == ScriptType::Unknown {
                return ok(CellType::Unknown);
            }

            // Prevent malformed output cells having ICKBScript as lock and and well known scripts as type.
            if self.source != Source::Input {
                return err(Error::ScriptMisuse);
            }
        }

        if type_script_type == ScriptType::ICKBScript {
            return ok(CellType::Receipt);
        }

        if type_script_type == ScriptType::TokenType {
            return ok(CellType::Token);
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
    TokenType,
    ICKBScript,
    Malformed,
}

fn script_type_(script: &Script, ickb_code_hash: [u8; 32]) -> ScriptType {
    let code_hash: [u8; 32] = script.code_hash().as_slice().try_into().unwrap();
    let hash_type = u8::from(script.hash_type());
    let args = script.args().as_slice().to_vec();
    let args_len = args.len();

    if NERVOS_DAO_CODE_HASH == code_hash {
        if NERVOS_DAO_HASH_TYPE == hash_type && NERVOS_DAO_ARGS_LEN == args_len {
            return ScriptType::NervosDaoType;
        }
        return ScriptType::Malformed;
    }

    if TOKEN_TYPE_CODE_HASH == code_hash {
        if TOKEN_TYPE_HASH_TYPE == hash_type
            && TOKEN_TYPE_ARGS_LEN == args_len
            && ickb_code_hash.as_slice() == args.as_slice()
        {
            return ScriptType::TokenType;
        }
        // Allow external tokens in the transaction
        return ScriptType::Unknown;
    }

    if ickb_code_hash == code_hash {
        if ICKB_SCRIPT_HASH_TYPE == hash_type && ICKB_SCRIPT_ARGS_LEN == args_len {
            return ScriptType::ICKBScript;
        }
        return ScriptType::Malformed;
    }

    return ScriptType::Unknown;
}

// From https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#example
const NERVOS_DAO_CODE_HASH: [u8; 32] =
    from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e");
const NERVOS_DAO_HASH_TYPE: u8 = ScriptHashType::Type as u8;
const NERVOS_DAO_ARGS_LEN: usize = 0;

// From https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0025-simple-udt/0025-simple-udt.md#notes
const TOKEN_TYPE_CODE_HASH: [u8; 32] =
    from_hex("0x5e7a36a77e68eecc013dfa2fe6a23f3b6c344b04005808694ae6dd45eea4cfd5");
const TOKEN_TYPE_HASH_TYPE: u8 = ScriptHashType::Type as u8;
const TOKEN_TYPE_ARGS_LEN: usize = 32;

const ICKB_SCRIPT_HASH_TYPE: u8 = ScriptHashType::Data1 as u8;
const ICKB_SCRIPT_ARGS_LEN: usize = 0;
