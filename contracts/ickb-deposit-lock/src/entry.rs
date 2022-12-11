use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, prelude::*},
    high_level::{load_cell_lock_hash, load_script, load_script_hash, QueryIter},
};

use crate::error::Error;

pub fn main() -> Result<(), Error> {
    // Deposit Lock state transitions are managed by the Owner Lock, let's validate what can be validated locally.

    let script = load_script()?;
    let owner_lock_bytes: Bytes = script.args().unpack();
    let owner_lock = owner_lock_bytes.to_vec();

    if owner_lock.len() != 32 {
        let script_hash = load_script_hash()?;
        let script_exists_in_output = QueryIter::new(load_cell_lock_hash, Source::Output)
            .any(|lock| lock.as_slice() == script_hash);

        // Since this is a lock script, validation will only occur on inputs, so malformed cell creation already happened.
        if !script_exists_in_output {
            // Permit retrieval of CKB locked in malformed cell.
            return Ok(());
        } else {
            // Block creation of new malformed cells.
            return Err(Error::Encoding);
        }
    }

    // Check that owner lock is included in the input of the transaction.
    let owner_lock_is_included = QueryIter::new(load_cell_lock_hash, Source::Input)
        .any(|lock| lock.as_slice() == owner_lock);

    if !owner_lock_is_included {
        return Err(Error::OwnerLockNotFound);
    }

    Ok(())
}
