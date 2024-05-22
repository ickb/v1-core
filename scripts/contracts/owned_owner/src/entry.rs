use core::{convert::TryInto, result::Result};

use alloc::collections::BTreeMap;
use ckb_std::{
    ckb_constants::Source,
    high_level::{
        load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_script_hash, QueryIter,
    },
};
use utils::{extract_metapoint, has_empty_args, MetaPoint};

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
                    // Note on Overflow: even locking all CKB supply in owner cells cannot overflow this counter
                    accounting.owner += 1;
                }
                (true, false) => {
                    // Owned Cell
                    let metapoint = extract_metapoint(index, source)?;
                    let accounting = metapoint_2_accounting.entry(metapoint).or_insert(default);
                    // Note on Overflow: even locking all CKB supply in owned cells cannot overflow this counter
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

fn extract_owned_metapoint(index: usize, source: Source) -> Result<MetaPoint, Error> {
    let metapoint = extract_metapoint(index, source)?;
    let owned_distance = load_cell_data(index, source)?;
    if owned_distance.len() != 4 {
        return Err(Error::Encoding);
    }

    let d = i32::from_le_bytes(owned_distance[..4].try_into().unwrap());
    return Ok(MetaPoint {
        tx_hash: metapoint.tx_hash,
        index: metapoint.index + d as i64,
    });
}
