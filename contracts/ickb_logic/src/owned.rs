use alloc::vec::Vec;

use crate::error::Error;

struct Data {
    key: [u8; 32], //tx_hash
    owned: u64,
    receipted: u64,
}

pub struct OwnedValidator(Vec<Data>);

impl OwnedValidator {
    pub fn new() -> OwnedValidator {
        OwnedValidator(Vec::with_capacity(10))
    }

    pub fn unspent_receipted(&mut self) -> Result<Vec<([u8; 32], u64)>, Error> {
        let mut unspent_receipted = Vec::with_capacity(self.0.len());

        // For each input receipt validate that owned cells less or equal to receipted
        for d in &self.0 {
            if d.receipted < d.owned {
                return Err(Error::OwnedNotReceipted);
            }
            if d.owned < d.receipted {
                unspent_receipted.push((d.key, d.receipted - d.owned));
            }
        }

        Ok(unspent_receipted)
    }

    pub fn add_receipted(&mut self, tx_hash: [u8; 32], quantity: u64) -> Result<(), Error> {
        let (position, _, receipted) = self.position(tx_hash)?;
        if receipted > 0 {
            return Err(Error::ReceiptAlreadyFound);
        }
        self.0[position].receipted = quantity;
        Ok(())
    }

    pub fn add_owned(&mut self, tx_hash: [u8; 32], quantity: u64) -> Result<(), Error> {
        let (position, owned, _) = self.position(tx_hash)?;
        // Note on Overflow: even locking the total CKB supply in Owned cells can't overflow this counter.
        self.0[position].owned = owned + quantity;
        Ok(())
    }

    fn position(&mut self, key: [u8; 32]) -> Result<(usize, u64, u64), Error> {
        match self.0.binary_search_by_key(&key, |d: &Data| d.key) {
            Err(position) => {
                self.0.insert(
                    position,
                    Data {
                        key,
                        owned: 0,
                        receipted: 0,
                    },
                );
                Ok((position, 0, 0))
            }
            Ok(position) => {
                let d = &self.0[position];
                Ok((position, d.owned, d.receipted))
            }
        }
    }
}
