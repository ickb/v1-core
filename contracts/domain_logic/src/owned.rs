use alloc::vec::Vec;
use ckb_std::{
    ckb_constants::Source, ckb_types::prelude::Unpack, high_level::load_input_out_point,
};

use crate::error::Error;

struct Data {
    key: [u8; 32], //txHash
    owned_count: u64,
    receipt_owned_count: u64,
}

pub struct OwnedInputValidator(Vec<Data>);

impl OwnedInputValidator {
    pub fn new() -> OwnedInputValidator {
        OwnedInputValidator(Vec::with_capacity(10))
    }

    pub fn validate(&self) -> Result<(), Error> {
        // For each input receipt validate that owned cells equal to receipt count
        for d in &self.0 {
            if d.owned_count != d.receipt_owned_count {
                return Err(Error::OwnedCountMismatch);
            }
        }
        Ok(())
    }

    pub fn add_receipt_cell(
        &mut self,
        index: usize,
        receipt_owned_count: u64,
    ) -> Result<(), Error> {
        let (position, _, old_receipt_owned_count) = self.position(index)?;
        if old_receipt_owned_count > 0 {
            return Err(Error::ReceiptAlreadyFound);
        }
        self.0[position].receipt_owned_count = receipt_owned_count;
        Ok(())
    }

    pub fn add_owned_cell(&mut self, index: usize) -> Result<(), Error> {
        let (position, owned_count, _) = self.position(index)?;
        // Note on Overflow: even locking the total CKB supply in Owned cells can't overflow this counter.
        self.0[position].owned_count = owned_count + 1;
        Ok(())
    }

    fn position(&mut self, index: usize) -> Result<(usize, u64, u64), Error> {
        let key = load_input_out_point(index, Source::Input)?
            .tx_hash()
            .unpack();

        match self.0.binary_search_by_key(&key, |d: &Data| d.key) {
            Err(position) => {
                self.0.insert(
                    position,
                    Data {
                        key,
                        owned_count: 0,
                        receipt_owned_count: 0,
                    },
                );
                Ok((position, 0, 0))
            }
            Ok(position) => {
                let d = &self.0[position];
                Ok((position, d.owned_count, d.receipt_owned_count))
            }
        }
    }
}
