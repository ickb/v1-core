use core::{convert::TryInto, result::Result};

use alloc::collections::BTreeMap;
use ckb_std::{
    ckb_constants::Source,
    high_level::{
        load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_script_hash, QueryIter,
    },
};
use utils::{extract_metapoint, MetaPoint};

use crate::error::Error;

pub fn main() -> Result<(), Error> {
    let script_hash = load_script_hash()?;
    let default = Accounting { owned: 0, owner: 0 };
    for source in [Source::Input, Source::Output] {
        let mut metapoint_2_accounting: BTreeMap<MetaPoint, Accounting> = BTreeMap::new();

        //Owned Cells
        for (index, _) in QueryIter::new(load_cell_lock_hash, source)
            .enumerate()
            .filter(|(_, h)| h == &script_hash)
        {
            let metapoint = extract_metapoint(source, index)?;
            let accounting = metapoint_2_accounting.entry(metapoint).or_insert(default);
            // Note on Overflow: even locking all CKB supply in owned cells cannot overflow this counter
            accounting.owned += 1;
        }

        //Owner Cells
        for (index, _) in QueryIter::new(load_cell_type_hash, source)
            .enumerate()
            .filter(|(_, maybe_h)| maybe_h == &Some(script_hash))
        {
            let metapoint = extract_owned_metapoint(source, index)?;
            let accounting = metapoint_2_accounting.entry(metapoint).or_insert(default);
            // Note on Overflow: even locking all CKB supply in owner cells cannot overflow this counter
            accounting.owner += 1;
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

fn extract_owned_metapoint(source: Source, index: usize) -> Result<MetaPoint, Error> {
    let metapoint = extract_metapoint(source, index)?;
    let owned_distance = load_cell_data(index, source)?;
    if owned_distance.len() < 4 {
        return Err(Error::Encoding);
    }

    let d = i32::from_le_bytes(owned_distance[..4].try_into().unwrap());

    return Ok(MetaPoint {
        tx_hash: metapoint.tx_hash,
        index: metapoint.index + d as i64,
    });
}
