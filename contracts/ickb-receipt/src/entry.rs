use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, prelude::*},
    high_level::{load_cell_data, load_cell_lock_hash, load_script, QueryIter},
};

use crate::error::Error;

pub fn main() -> Result<(), Error> {
    // Receipt state transitions are managed by the Owner Lock, let's validate what can be validated locally.
    let script = load_script()?;
    let owner_lock_bytes: Bytes = script.args().unpack();
    let owner_lock = owner_lock_bytes.to_vec();

    if owner_lock.len() != 32 {
        return Err(Error::Encoding);
    }

    // Check that owner lock is included in the input of the transaction.
    let owner_lock_is_included = QueryIter::new(load_cell_lock_hash, Source::Input)
        .any(|lock| lock.as_slice() == owner_lock);

    if !owner_lock_is_included {
        return Err(Error::OwnerLockNotFound);
    }

    // This script is used by the Owner Lock as type script, so input has already been previously validated.
    // So we just need to validate that output cell data is 16 bytes.
    if QueryIter::new(load_cell_data, Source::GroupOutput).any(|data| data.len() < 16) {
        return Err(Error::Encoding);
    }

    Ok(())
}
