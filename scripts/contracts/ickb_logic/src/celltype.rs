use core::{convert::TryInto, result::Result};

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        bytes::Bytes,
        packed::{Byte32, ScriptBuilder},
        prelude::*,
    },
    high_level::{load_cell_lock_hash, load_cell_type_hash},
    syscalls::SysError,
};

use crate::{
    constants::{
        DAO_ARGS, DAO_CODE_HASH, DAO_HASH_TYPE, XUDT_ARGS_FLAGS, XUDT_CODE_HASH, XUDT_HASH_TYPE,
    },
    error::Error,
    utils::is_deposit_cell,
};

pub struct CellTypeIter {
    index: usize,
    source: Source,
    ickb_logic_hash: [u8; 32],
    ickb_xudt_hash: [u8; 32],
    dao_hash: [u8; 32],
}

pub enum CellType {
    Unknown,
    Deposit,
    Receipt,
    Udt,
}

impl Iterator for CellTypeIter {
    type Item = Result<(usize, Source, CellType), Error>;

    // Iterates over the specified sources, returning the index and type of found iCKB cells
    // Returns an error in case of preventable iCKB scripts misuse in output cells
    fn next(&mut self) -> Option<Self::Item> {
        let err = |e| Some(Err(e));

        let (lock_script_type, type_script_type) = match (
            load_cell_lock_hash(self.index, self.source),
            load_cell_type_hash(self.index, self.source),
        ) {
            // No more cells
            (Err(SysError::IndexOutOfBound), ..) => return None,
            // Unknown error
            (Err(e), ..) | (.., Err(e)) => return err(Error::from(e)),
            // A new cell exists
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

        match (lock_script_type, type_script_type) {
            // General errors in cell structure to bubble up
            (ScriptType::DaoDeposit, _) => err(Error::ScriptMisuse),
            (ScriptType::IckbUdt, _) => err(Error::ScriptMisuse),
            (ScriptType::None, _) => err(Error::ScriptMisuse),

            // Protocol specific validation

            // Deposit
            (ScriptType::IckbLogic, ScriptType::DaoDeposit) => ok(CellType::Deposit),

            // Invalid
            (ScriptType::IckbLogic, _) => err(Error::ScriptMisuse),

            // Receipt
            (_, ScriptType::IckbLogic) => ok(CellType::Receipt),

            // UDT Cell
            (_, ScriptType::IckbUdt) => ok(CellType::Udt),

            // Unknown
            (ScriptType::Unknown, _) => ok(CellType::Unknown),
        }
    }
}

enum ScriptType {
    None,
    Unknown,
    DaoDeposit,
    IckbLogic,
    IckbUdt,
}

impl CellTypeIter {
    fn script_type(&self, h: [u8; 32]) -> ScriptType {
        if h == self.dao_hash {
            // This condition checks that's a deposit, not a withdrawal request or an unknown cell
            if is_deposit_cell(self.index, self.source) {
                return ScriptType::DaoDeposit;
            } else {
                return ScriptType::Unknown;
            }
        }

        if h == self.ickb_xudt_hash {
            return ScriptType::IckbUdt;
        }

        if h == self.ickb_logic_hash {
            return ScriptType::IckbLogic;
        }

        return ScriptType::Unknown;
    }
}

pub fn cell_type_iter(source: Source, ickb_logic_hash: [u8; 32]) -> CellTypeIter {
    let ickb_xudt_args = [ickb_logic_hash.as_slice(), XUDT_ARGS_FLAGS.as_slice()].concat();
    let ickb_xudt_hash: [u8; 32] = ScriptBuilder::default()
        .code_hash(Byte32::from_slice(&XUDT_CODE_HASH).unwrap())
        .hash_type(XUDT_HASH_TYPE.into())
        .args(Bytes::from(ickb_xudt_args).pack())
        .build()
        .calc_script_hash()
        .as_slice()
        .try_into()
        .unwrap();

    let dao_hash: [u8; 32] = ScriptBuilder::default()
        .code_hash(Byte32::from_slice(&DAO_CODE_HASH).unwrap())
        .hash_type(DAO_HASH_TYPE.into())
        .args(Bytes::from(DAO_ARGS.as_slice()).pack())
        .build()
        .calc_script_hash()
        .as_slice()
        .try_into()
        .unwrap();

    CellTypeIter {
        index: 0,
        source,
        ickb_logic_hash,
        ickb_xudt_hash,
        dao_hash,
    }
}
