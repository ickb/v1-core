use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        bytes::Bytes,
        core::ScriptHashType,
        packed::{Byte32, ScriptBuilder},
        prelude::*,
    },
    high_level::{load_cell_lock_hash, load_cell_type_hash},
    syscalls::SysError,
};

use ckb_utils::{from_hex, hash_script};

use crate::{error::Error, utils::cell_data_is_8_zeroed_bytes};

pub struct CellTypeIter {
    index: usize,
    source: Source,
    ickb_script_hash: [u8; 32],
    ickb_sudt_script_hash: [u8; 32],
    nervos_dao_script_hash: [u8; 32],
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
        let err = |e| Some(Err(e));

        let (lock_script_type, type_script_type) = match (
            load_cell_lock_hash(self.index, self.source),
            load_cell_type_hash(self.index, self.source),
        ) {
            // No more cells.
            (Err(SysError::IndexOutOfBound), ..) => return None,
            // Unknown error.
            (Err(e), ..) | (.., Err(e)) => return err(Error::from(e)),
            // A new cell exists.
            (Ok(lock_script_hash), Ok(maybe_type_script_hash)) => (
                self.script_type(lock_script_hash),
                maybe_type_script_hash.map_or(ScriptType::None, |h| self.script_type(h)),
            ),
        };

        let mut ok = |cell_type| {
            let index = self.index;
            self.index += 1;
            Some(Ok((index, self.source, cell_type)))
        };

        match (lock_script_type, type_script_type, self.source) {
            (ScriptType::ICKBScript, ScriptType::NervosDaoDeposit, _) => ok(CellType::Deposit),
            (ScriptType::ICKBScript, ScriptType::None, _) => ok(CellType::Unknown),
            (ScriptType::ICKBScript, ScriptType::Unknown, _) => ok(CellType::Unknown),
            (ScriptType::ICKBScript, _, Source::Input) => ok(CellType::Unknown),
            (ScriptType::ICKBScript, _, _) => err(Error::ScriptMisuse),
            (_, ScriptType::ICKBScript, _) => ok(CellType::Receipt),
            (_, ScriptType::ICKBSUDT, _) => ok(CellType::Token),
            (_, _, Source::Input) => ok(CellType::Unknown),
            (ScriptType::Unknown, ScriptType::None, _) => ok(CellType::Unknown),
            (ScriptType::Unknown, ScriptType::Unknown, _) => ok(CellType::Unknown),
            (ScriptType::Unknown, ScriptType::NervosDaoDeposit, _) => ok(CellType::Unknown),
            _ => err(Error::ScriptMisuse),
        }
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum ScriptType {
    None,
    Unknown,
    NervosDaoDeposit,
    ICKBScript,
    ICKBSUDT,
}

impl CellTypeIter {
    fn script_type(&self, h: [u8; 32]) -> ScriptType {
        if h == self.nervos_dao_script_hash {
            // This condition checks that's a deposit, not a withdrawal.
            if cell_data_is_8_zeroed_bytes(self.index, self.source) {
                return ScriptType::NervosDaoDeposit;
            } else {
                return ScriptType::Unknown;
            }
        }

        if h == self.ickb_sudt_script_hash {
            return ScriptType::ICKBSUDT;
        }

        if h == self.ickb_script_hash {
            return ScriptType::ICKBScript;
        }

        return ScriptType::Unknown;
    }
}

pub fn cell_type_iter(source: Source, ickb_script_hash: [u8; 32]) -> CellTypeIter {
    // use ckb_std::ckb_types::bytes::Bytes;

    let ickb_sudt_script_hash = hash_script(
        &ScriptBuilder::default()
            .code_hash(Byte32::from_slice(&SUDT_CODE_HASH).unwrap())
            .hash_type(SUDT_HASH_TYPE.into())
            .args(Bytes::from(ickb_script_hash.as_slice()).pack())
            .build(),
    );

    let nervos_dao_script_hash = hash_script(
        &ScriptBuilder::default()
            .code_hash(Byte32::from_slice(&NERVOS_DAO_CODE_HASH).unwrap())
            .hash_type(NERVOS_DAO_HASH_TYPE.into())
            .args(Bytes::from(NERVOS_DAO_ARGS.as_slice()).pack())
            .build(),
    );

    CellTypeIter {
        index: 0,
        source,
        ickb_script_hash,
        ickb_sudt_script_hash,
        nervos_dao_script_hash,
    }
}

// From https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#example
const NERVOS_DAO_CODE_HASH: [u8; 32] =
    from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e");
const NERVOS_DAO_HASH_TYPE: u8 = ScriptHashType::Type as u8;
const NERVOS_DAO_ARGS: [u8; 0] = [];

// From https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0025-simple-udt/0025-simple-udt.md#notes
const SUDT_CODE_HASH: [u8; 32] = from_hex(if cfg!(devnet) {
    "0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419"
} else if cfg!(testnet) {
    "0xc5e5dcf215925f7ef4dfaf5f4b4f105bc321c02776d6e7d52a1db3fcd9d011a4"
} else
/*mainnet*/
{
    "0x5e7a36a77e68eecc013dfa2fe6a23f3b6c344b04005808694ae6dd45eea4cfd5"
});

const SUDT_HASH_TYPE: u8 = if cfg!(devnet) {
    ScriptHashType::Data as u8
} else
/*testnet or mainnet*/
{
    ScriptHashType::Type as u8
};
