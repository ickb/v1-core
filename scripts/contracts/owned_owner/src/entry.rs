use core::result::Result;

use alloc::collections::BTreeMap;
use ckb_std::{
    ckb_constants::Source,
    high_level::{load_cell_lock_hash, load_cell_type_hash, load_script_hash, QueryIter},
    syscalls::{load_cell_data, SysError},
};
use utils::{extract_metapoint, has_empty_args, is_dao, is_withdrawal_request_data, MetaPoint};

use crate::error::Error;

pub fn main() -> Result<(), Error> {
    if !has_empty_args()? {
        return Err(Error::NotEmptyArgs);
    }

    let script_hash = load_script_hash()?;
    let is_script = |index: usize, source: Source| {
        Ok((
            load_cell_lock_hash(index, source)? == script_hash,
            load_cell_type_hash(index, source)? == Some(script_hash),
        ))
    };

    let default = Accounting { owned: 0, owner: 0 };
    for source in [Source::Input, Source::Output] {
        let mut metapoint_2_accounting: BTreeMap<MetaPoint, Accounting> = BTreeMap::new();

        for (index, is_script) in QueryIter::new(is_script, source).enumerate() {
            match is_script {
                (false, false) => (),
                (false, true) => {
                    // Owner Cell
                    let metapoint = extract_owned_metapoint(index, source)?;
                    let accounting = metapoint_2_accounting.entry(metapoint).or_insert(default);
                    accounting.owner += 1;
                }
                (true, false) => {
                    // Owned Cell

                    // Check that is a Withdrawal Request
                    if !is_dao(index, source)? || !is_withdrawal_request_data(index, source) {
                        return Err(Error::NotWithdrawalRequest);
                    }

                    let metapoint = extract_metapoint(index, source)?;
                    let accounting = metapoint_2_accounting.entry(metapoint).or_insert(default);
                    accounting.owned += 1;
                }
                (true, true) => return Err(Error::ScriptMisuse),
            }
        }

        if metapoint_2_accounting
            .into_values()
            .any(|a| a.owned != 1 || a.owner != 1)
        {
            return Err(Error::Mismatch);
        }
    }

    Ok(())
}

#[derive(Clone, Copy)]
struct Accounting {
    owned: u64,
    owner: u64,
}

const OWNED_DISTANCE_SIZE: usize = 4;

fn extract_owned_metapoint(index: usize, source: Source) -> Result<MetaPoint, Error> {
    let metapoint = extract_metapoint(index, source)?;

    let mut data = [0u8; OWNED_DISTANCE_SIZE];
    let d = match load_cell_data(&mut data, 0, index, source) {
        Ok(OWNED_DISTANCE_SIZE) | Err(SysError::LengthNotEnough(_)) => i32::from_le_bytes(data),
        Ok(_) => return Err(Error::Encoding),
        Err(err) => return Err(Error::from(err)),
    };

    return Ok(MetaPoint {
        tx_hash: metapoint.tx_hash,
        index: metapoint.index + d as i64,
    });
}
