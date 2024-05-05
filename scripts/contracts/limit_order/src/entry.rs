use crate::error::Error;
use alloc::collections::BTreeMap;
use core::result::Result;
use primitive_types::U256;

use ckb_std::{ckb_constants::Source, high_level::*};
use utils::{extract_metapoint, extract_udt_cell_data, has_empty_args, MetaPoint};

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
            // Match Order or Fulfill Order
            (Some(i), false, Some(o), false) => validate(i, o)?,
            // Every other configuration is invalid
            _ => return Err(Error::InvalidConfiguration),
        }
    }

    Ok(())
}

fn validate(i: Data, o: Data) -> Result<(), Error> {
    if i.udt_hash != o.udt_hash {
        return Err(Error::DifferentType);
    }

    let (m, is_fulfilled) = match (i.metadata, o.metadata) {
        (Some(m), None) => {
            let residual = if m.is_udt_to_ckb {
                o.udt
            } else {
                o.ckb_unoccupied
            };
            // No residual value to convert
            if !residual.is_zero() {
                return Err(Error::NotFulfilled);
            }
            (m, true)
        }
        (Some(in_m), Some(out_m)) => {
            // Check that order Metadata between input and output matches
            if in_m != out_m {
                return Err(Error::DifferentMetadata);
            }
            (in_m, false)
        }
        (None, ..) => return Err(Error::AttemptToChangeFulfilled),
    };

    // Check that limit order does not lose value
    // Note on Overflow: u128 quantities represented with u256, no overflow is possible
    if i.ckb * m.ckb_mul + i.udt * m.udt_mul > o.ckb * m.ckb_mul + o.udt * m.udt_mul {
        return Err(Error::DecreasingValue);
    }

    if is_fulfilled {
        return Ok(());
    }

    // Validate limit order partial match
    if m.is_udt_to_ckb {
        // UDT -> CKB

        // DOS prevention: disallow partial match lower than the equivalent of min_ckb_match CKB
        // Note on Overflow: u128 quantities represented with u256, no overflow is possible
        if i.ckb + m.min_ckb_match > o.ckb {
            return Err(Error::InsufficientMatch);
        }

        // Leave at least min_ckb_match equivalent of udt for the complete fulfillment
        if o.udt * m.udt_mul < m.min_ckb_match * m.ckb_mul {
            return Err(Error::InsufficientResidual);
        }
    } else {
        // CKB -> UDT

        // Disallow partial match lower than the equivalent of min_ckb_match
        // Note on Overflow: u128 quantities represented with u256, no overflow is possible
        if i.udt * m.udt_mul + m.min_ckb_match * m.ckb_mul > o.udt * m.udt_mul {
            return Err(Error::InsufficientMatch);
        }

        // Leave at least min_ckb_match for the complete fulfillment step
        if o.ckb_unoccupied + ORDER_INFO < m.min_ckb_match {
            return Err(Error::InsufficientResidual);
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
    ckb: U256,
    udt: U256,
    ckb_unoccupied: U256,
    udt_hash: [u8; 32],
    metadata: Option<Metadata>,
}

#[derive(Clone, Copy, PartialEq)]
struct Metadata {
    is_udt_to_ckb: bool,
    ckb_mul: U256,
    udt_mul: U256,
    min_ckb_match: U256,
}

fn extract_order(index: usize, source: Source) -> Result<(MetaPoint, Data), Error> {
    let (udt_amount, order_raw_data) = extract_udt_cell_data(index, source)?;

    let mut raw_data = &order_raw_data[..];
    let mut load = |size: usize| {
        if raw_data.len() < size {
            return Err(Error::Encoding);
        }
        let field_data: &[u8];
        (field_data, raw_data) = raw_data.split_at(size);
        return Ok(field_data);
    };

    let action = match u32::from_le_bytes(load(ACTION)?.try_into().unwrap()) {
        0 => Action::Mint,
        1 => Action::Match,
        2 => Action::Fulfill,
        _ => return Err(Error::InvalidAction),
    };

    let master_metapoint = if action == Action::Mint {
        let metapoint = extract_metapoint(index, source)?;
        let d = u32::from_le_bytes(load(MASTER_DISTANCE)?.try_into().unwrap());
        MetaPoint {
            tx_hash: metapoint.tx_hash,
            index: metapoint.index + d as i64,
        }
    } else {
        let tx_hash: [u8; 32] = load(TX_HASH)?.try_into().unwrap();
        let index = i32::from_le_bytes(load(INDEX)?.try_into().unwrap());
        MetaPoint {
            tx_hash: Some(tx_hash),
            index: i64::from(index),
        }
    };

    let metadata = if action == Action::Fulfill {
        None
    } else {
        let is_udt_to_ckb: bool = load(IS_UDT_TO_CKB)?[0] != 0;
        let ckb_mul = U256::from(u64::from_le_bytes(
            load(CKB_MULTIPLIER)?.try_into().unwrap(),
        ));
        let udt_mul = U256::from(u64::from_le_bytes(
            load(UDT_MULTIPLIER)?.try_into().unwrap(),
        ));
        let min_ckb_match = U256::from(1) << load(LOG_MIN_CKB_MATCH)?[0].min(64);
        Some(Metadata {
            is_udt_to_ckb,
            ckb_mul,
            udt_mul,
            min_ckb_match,
        })
    };

    // There must be no remaining data in raw_data
    if raw_data.len() > 0 {
        return Err(Error::DataTooLong);
    }

    let ckb = U256::from(load_cell_capacity(index, source)?);
    let ckb_unoccupied = ckb - U256::from(load_cell_occupied_capacity(index, source)?);

    let udt = U256::from(udt_amount);
    let udt_hash = match load_cell_type_hash(index, source)? {
        Some(h) => h,
        None => return Err(Error::MissingUdtType),
    };

    let order_data = Data {
        ckb,
        udt,
        ckb_unoccupied,
        udt_hash,
        metadata,
    };

    Ok((master_metapoint, order_data))
}

const ACTION: usize = 4;

#[derive(PartialEq, Eq)]
enum Action {
    Mint = 0,
    Match,
    Fulfill,
}

// struct OutPoint {
const TX_HASH: usize = 32;
const INDEX: usize = 4;
// }

// struct OrderInfo {
const IS_UDT_TO_CKB: usize = 1;
const CKB_MULTIPLIER: usize = 8;
const UDT_MULTIPLIER: usize = 8;
const LOG_MIN_CKB_MATCH: usize = 1;
// }
const ORDER_INFO: usize = IS_UDT_TO_CKB + CKB_MULTIPLIER + CKB_MULTIPLIER + LOG_MIN_CKB_MATCH;

// struct MintOrderData { // UnionId: 0
const MASTER_DISTANCE: usize = 4;
// const ORDER_INFO : usize = ORDER_INFO;
// }

// struct MatchOrderData { // UnionId: 1
// const MASTER_OUTPOINT : usize = OUTPOINT;
// const ORDER_INFO : usize = ORDER_INFO;
// }

// struct FulfillOrderData { // UnionId: 2
// const MASTER_OUTPOINT: usize = OUTPOINT;
// }
