use crate::error::Error;
use crate::utils::C256;
use alloc::collections::BTreeMap;
use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    high_level::{
        load_cell_capacity, load_cell_lock_hash, load_cell_occupied_capacity, load_cell_type_hash,
        load_script_hash, QueryIter,
    },
    syscalls::load_cell_data,
};
use utils::{extract_metapoint, has_empty_args, MetaPoint, UDT_SIZE};

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

    let mut metapoint_2_order: BTreeMap<MetaPoint, [Order; 2]> = BTreeMap::new();
    let default = [Order {
        data: None,
        has_master: false,
    }; 2];

    for source in [Source::Input, Source::Output] {
        for (index, is_script) in QueryIter::new(is_script, source).enumerate() {
            match is_script {
                (false, false) => (),
                (false, true) => {
                    // Master Cell
                    let metapoint = extract_metapoint(index, source)?;
                    let io_accounting = metapoint_2_order.entry(metapoint).or_insert(default);
                    // No two cells exists with the same outpoint, so this should not happen
                    if io_accounting[source as usize - 1].has_master == true {
                        return Err(Error::DuplicatedMaster);
                    }
                    io_accounting[source as usize - 1].has_master = true;
                }
                (true, false) => {
                    // Limit Order Cell
                    let (metapoint, data) = extract_order(index, source)?;
                    let io_accounting = metapoint_2_order.entry(metapoint).or_insert(default);
                    if io_accounting[source as usize - 1].data != None {
                        return Err(Error::SameMaster);
                    }
                    io_accounting[source as usize - 1].data = Some(data);
                }
                (true, true) => return Err(Error::ScriptMisuse),
            }
        }
    }

    // Validate actions
    for [Order {
        data: in_maybe_data,
        has_master: in_has_master,
    }, Order {
        data: out_maybe_data,
        has_master: out_has_master,
    }] in metapoint_2_order.into_values()
    {
        match (in_maybe_data, in_has_master, out_maybe_data, out_has_master) {
            // Mint Order
            (None, false, Some(_), true) => (),
            // Melt Order
            (Some(_), true, None, false) => (),
            // Match Order
            (Some(i), false, Some(o), false) => validate(i, o)?,
            // Every other configuration is invalid
            _ => return Err(Error::InvalidConfiguration),
        }
    }

    Ok(())
}

fn validate(i: Data, o: Data) -> Result<(), Error> {
    if i.info != o.info {
        return Err(Error::DifferentInfo);
    }

    let (is_ckb_to_udt, Ratio { ckb_mul, udt_mul }, ckb_min_match) = match (
        i.info.ckb_to_udt,
        i.ckb > o.ckb,
        i.info.udt_to_ckb,
        i.udt > o.udt,
    ) {
        (Some(ratio), true, _, false) => (true, ratio, i.info.ckb_min_match),
        (_, false, Some(ratio), true) => (false, ratio, i.info.ckb_min_match),
        _ => return Err(Error::InvalidMatch),
    };

    // Check that limit order does not lose value
    if i.ckb * ckb_mul + i.udt * udt_mul > o.ckb * ckb_mul + o.udt * udt_mul {
        return Err(Error::DecreasingValue);
    }

    // Validate limit order match
    if is_ckb_to_udt {
        // CKB -> UDT
        // Check that an already fulfilled order is not modified
        if i.ckb_unoccupied.is_zero() {
            return Err(Error::AttemptToChangeFulfilled);
        }

        // DOS prevention: disallow partial match lower than the equivalent of ckb_min_match
        if !o.ckb_unoccupied.is_zero() && i.ckb < o.ckb + ckb_min_match {
            return Err(Error::InsufficientMatch);
        }
    } else {
        // UDT -> CKB
        // Check that an already fulfilled order is not modified
        if i.udt.is_zero() {
            return Err(Error::AttemptToChangeFulfilled);
        }

        // DOS prevention: disallow partial match lower than the equivalent of ckb_min_match
        if !o.udt.is_zero() && i.udt * udt_mul < o.udt * udt_mul + ckb_min_match * ckb_mul {
            return Err(Error::InsufficientMatch);
        }
    }

    Ok(())
}

#[derive(Clone, Copy, PartialEq)]
struct Order {
    data: Option<Data>,
    has_master: bool,
}

#[derive(Clone, Copy, PartialEq)]
struct Data {
    ckb: C256,
    udt: C256,
    ckb_unoccupied: C256,
    info: Info,
}

#[derive(Clone, Copy, PartialEq)]
struct Info {
    udt_hash: [u8; 32],
    ckb_to_udt: Option<Ratio>,
    udt_to_ckb: Option<Ratio>,
    ckb_min_match: C256,
}

#[derive(Clone, Copy, PartialEq)]
struct Ratio {
    ckb_mul: C256,
    udt_mul: C256,
}

fn extract_order(index: usize, source: Source) -> Result<(MetaPoint, Data), Error> {
    let mut data = [0u8; UDT_SIZE + ORDER_SIZE];

    if load_cell_data(&mut data, 0, index, source)? != data.len() {
        return Err(Error::Encoding);
    }

    // Data splitter
    let mut raw_data = data.as_slice();
    let mut load = |size: usize| {
        let field_data: &[u8];
        (field_data, raw_data) = raw_data.split_at(size);
        return field_data;
    };

    let udt_amount = u128::from_le_bytes(load(UDT_SIZE).try_into().unwrap());

    let action = match u32::from_le_bytes(load(ACTION_SIZE).try_into().unwrap()) {
        0 => Action::Mint,
        1 => Action::Match,
        _ => return Err(Error::InvalidAction),
    };

    let master_metapoint = {
        let raw_tx_hash = load(TX_HASH_SIZE);
        let raw_index = load(INDEX_SIZE);
        if action == Action::Mint {
            if raw_tx_hash != [0u8; 32] {
                return Err(Error::NonZeroPadding);
            }
            let master_distance = i32::from_le_bytes(raw_index.try_into().unwrap());
            let metapoint = extract_metapoint(index, source)?;
            MetaPoint {
                tx_hash: metapoint.tx_hash,
                index: metapoint.index + master_distance as i64,
            }
        } else {
            let tx_hash: [u8; 32] = raw_tx_hash.try_into().unwrap();
            let index = u32::from_le_bytes(raw_index.try_into().unwrap());
            MetaPoint {
                tx_hash: Some(tx_hash),
                index: i64::from(index),
            }
        }
    };

    let mut load_ratio = || -> Result<Option<Ratio>, Error> {
        let ckb_mul = C256::from(u64::from_le_bytes(load(CKB_MUL_SIZE).try_into().unwrap()));
        let udt_mul = C256::from(u64::from_le_bytes(load(UDT_MUL_SIZE).try_into().unwrap()));
        match (ckb_mul.is_zero(), udt_mul.is_zero()) {
            (false, false) => Ok(Some(Ratio { ckb_mul, udt_mul })),
            (true, true) => Ok(None),
            _ => Err(Error::InvalidRatio),
        }
    };

    let ckb_to_udt = load_ratio()?;
    let udt_to_ckb = load_ratio()?;
    let ckb_min_match = match load(CKB_MIN_MATCH_LOG_SIZE)[0] {
        n @ 0..=64 => C256::from(1u128 << n),
        _ => return Err(Error::InvalidCkbMinMatchLog),
    };

    // Validate both ratio
    match (ckb_to_udt, udt_to_ckb) {
        (Some(c2u), Some(u2c)) => {
            // Check that if we convert from ckb to udt and then back from udt to ckb, it doesn't lose value.
            // ((initial_ckb * c2u.ckb_mul / c2u.udt_mul) * u2c.udt_mul / u2c.ckb_mul) >= initial_ckb
            // ~ initial_ckb * c2u.ckb_mul * u2c.udt_mul >= initial_ckb * c2u.udt_mul * u2c.ckb_mul
            // ~ c2u.ckb_mul * u2c.udt_mul >= c2u.udt_mul * u2c.ckb_mul
            if c2u.ckb_mul * u2c.udt_mul < c2u.udt_mul * u2c.ckb_mul {
                return Err(Error::ConcaveRatio);
            }
        }
        (None, None) => return Err(Error::BothRatioNull),
        _ => (),
    };

    let ckb = C256::from(load_cell_capacity(index, source)?);
    let ckb_unoccupied = ckb - C256::from(load_cell_occupied_capacity(index, source)?);

    let udt = C256::from(udt_amount);
    let udt_hash = match load_cell_type_hash(index, source)? {
        Some(h) => h,
        None => return Err(Error::MissingUdtType),
    };

    let order_data = Data {
        ckb,
        udt,
        ckb_unoccupied,
        info: Info {
            udt_hash,
            ckb_to_udt,
            udt_to_ckb,
            ckb_min_match,
        },
    };

    Ok((master_metapoint, order_data))
}

#[derive(PartialEq, Eq)]
enum Action {
    Mint = 0,
    Match,
}

const ORDER_SIZE: usize = ACTION_SIZE
    + TX_HASH_SIZE
    + INDEX_SIZE
    + 2 * (CKB_MUL_SIZE + UDT_MUL_SIZE)
    + CKB_MIN_MATCH_LOG_SIZE;

// ORDER_DATA = {
const ACTION_SIZE: usize = 4;
//   OUT_POINT = { // Or padding and master_distance if ACTION is Mint
const TX_HASH_SIZE: usize = 32;
const INDEX_SIZE: usize = 4;
//   }
//   ORDER_INFO = {
//     CKB_TO_UDT, UDT_TO_CKB = {
const CKB_MUL_SIZE: usize = 8;
const UDT_MUL_SIZE: usize = 8;
//     }
const CKB_MIN_MATCH_LOG_SIZE: usize = 1;
//   }
// }
