use crate::error::Error;
use core::result::Result;
use primitive_types::U256;
use utils::{u128_from, u64_from};

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        bytes::Bytes,
        packed::{Byte32, Script, ScriptBuilder},
        prelude::*,
    },
    high_level::*,
};

pub fn main() -> Result<(), Error> {
    let current_script = load_script()?;

    let limit_order_group_iterator = || {
        QueryIter::new(load_cell_lock, Source::Input)
            .enumerate()
            .filter(|(_, s)| s.as_slice() == current_script.as_slice())
    };

    for (index, script) in limit_order_group_iterator() {
        validate(index, &script)?;
    }

    Ok(())
}

fn validate(index: usize, script: &Script) -> Result<(), Error> {
    // Validate input
    let in_script = load_cell_lock(index, Source::Input)?;
    let (
        terminal_lock,
        sudt_hash,
        is_sudt_to_ckb,
        ckb_multiplier,
        sudt_multiplier,
        min_fulfillment,
    ) = extract_args_data(&script)?;
    let (in_ckb_amount, in_sudt_amount, _, _) = extract_amounts(index, Source::Input, sudt_hash)?;

    // Validate output
    let out_script = load_cell_lock(index, Source::Output)?;
    if out_script.as_slice() != in_script.as_slice()
        && out_script.as_slice() != terminal_lock.as_slice()
    {
        return Err(Error::InvalidOutputLock);
    }

    let (out_ckb_amount, out_sudt_amount, script_type, cell_data_len) =
        extract_amounts(index, Source::Output, sudt_hash)?;

    // Output lock is given to UI as address, so the output lock should not use additional cell data
    match (script_type, cell_data_len) {
        (ScriptType::None, 0) => (),
        (ScriptType::SUDT, 16) => (),
        _ => return Err(Error::InvalidInputType),
    };

    // Check that limit order does not lose value
    // Note on Overflow: u128 quantities represented with u256, no overflow is possible
    if in_ckb_amount * ckb_multiplier + in_sudt_amount * sudt_multiplier
        > out_ckb_amount * ckb_multiplier + out_sudt_amount * sudt_multiplier
    {
        return Err(Error::DecreasingValue);
    }

    // Validate limit order fulfillment while preventing DoS and leaving enough CKB for terminal lock state rent
    // SUDT -> CKB

    let is_owner_mode = || {
        QueryIter::new(load_cell_lock, Source::Input)
            .any(|s| s.as_slice() == terminal_lock.as_slice())
    };

    if is_sudt_to_ckb {
        // Terminal state
        if out_script.as_slice() == terminal_lock.as_slice() && script_type == ScriptType::None {
            return Ok(());
        }

        // Partially fulfilled
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::SUDT
            // DoS prevention: disallow partial fulfillments lower than min_fulfillment CKB
            && in_ckb_amount + min_fulfillment  <= out_ckb_amount
        {
            return Ok(());
        }

        // Recovery using owner lock
        if out_script.as_slice() == terminal_lock.as_slice() && is_owner_mode() {
            return Ok(());
        }

        return Err(Error::InvalidAction);
    } else {
        // CKB -> SUDT
        // Terminal state
        if out_script.as_slice() == terminal_lock.as_slice()
            && script_type == ScriptType::SUDT
            && load_cell_capacity(index, Source::Output)
                == load_cell_occupied_capacity(index, Source::Output)
        {
            return Ok(());
        }

        // Partially fulfilled
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::SUDT
            // DOS prevention: disallow partial fulfillments lower than the equivalent of min_fulfillment CKB
            // Note on Overflow: u128 quantities represented with u256, no overflow is possible
            && in_sudt_amount * sudt_multiplier + min_fulfillment * ckb_multiplier
                <= out_sudt_amount * sudt_multiplier
        {
            return Ok(());
        }

        // Recovery using owner lock
        if out_script.as_slice() == terminal_lock.as_slice() && is_owner_mode() {
            return Ok(());
        }

        return Err(Error::InvalidAction);
    }
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum ScriptType {
    None,
    Unknown,
    SUDT,
}

fn extract_amounts(
    index: usize,
    source: Source,
    sudt_hash: [u8; 32],
) -> Result<(U256, U256, ScriptType, usize), Error> {
    let ckb_amount = U256::from(load_cell_capacity(index, source)?);

    let data = load_cell_data(index, source)?;

    let (sudt_amount, script_type) = match load_cell_type_hash(index, source)? {
        None => (U256::from(0), ScriptType::None),
        Some(h) if h == sudt_hash => (U256::from(u128_from(&data, 0)?), ScriptType::SUDT),
        Some(_) => (U256::from(0), ScriptType::Unknown),
    };

    let cell_data_len = data.len();

    return Ok((ckb_amount, sudt_amount, script_type, cell_data_len));
}

// Arg data layout in bytes
// {
const UNION_ID: usize = 4;
const TERMINAL_LOCK_CODE_HASH: usize = 32;
const TERMINAL_LOCK_HASH_TYPE: usize = 1;
//  const TERMINAL_LOCK_ARGS : usize = load(UNION_ID);
const SUDT_HASH: usize = 32;
const IS_SUDT_TO_CKB: usize = 1;
const CKB_MULTIPLIER: usize = 8;
const SUDT_MULTIPLIER: usize = 8;
const LOG_MIN_FULFILLMENT: usize = 1;
// }

pub fn extract_args_data(
    script: &Script,
) -> Result<(Script, [u8; 32], bool, U256, U256, U256), Error> {
    let args: Bytes = script.args().unpack();

    let minimum_length = UNION_ID
        + TERMINAL_LOCK_CODE_HASH
        + TERMINAL_LOCK_HASH_TYPE
        + SUDT_HASH
        + IS_SUDT_TO_CKB
        + CKB_MULTIPLIER
        + SUDT_MULTIPLIER
        + LOG_MIN_FULFILLMENT;
    if args.len() < minimum_length {
        return Err(Error::ArgsTooShort);
    }
    let terminal_lock_args: usize = args.len() - minimum_length;

    //Data splitter
    let mut raw_data = &args[..];
    let mut load = |size: usize| {
        let field_data: &[u8];
        (field_data, raw_data) = raw_data.split_at(size);
        return field_data;
    };

    //Check that union id is indeed equal to terminal lock args size
    if u32::from_le_bytes(load(UNION_ID).try_into().unwrap()) as usize != terminal_lock_args {
        return Err(Error::InvalidUnionId);
    }

    let terminal_lock = ScriptBuilder::default()
        .code_hash(Byte32::new_unchecked(
            load(TERMINAL_LOCK_CODE_HASH).to_vec().into(),
        ))
        .hash_type(load(TERMINAL_LOCK_HASH_TYPE)[0].into())
        .args(Bytes::from(load(terminal_lock_args).to_vec()).pack())
        .build();

    let sudt_hash: [u8; 32] = load(SUDT_HASH).try_into().unwrap();
    let is_sudt_to_ckb = load(IS_SUDT_TO_CKB)[0] != 0;

    // Multipliers are only positive numbers, so they are encoded subtracting 1 to avoid the zero value
    // Note on Overflow: u64 quantities represented with u256, no overflow is possible
    let ckb_multiplier = U256::from(u64_from(load(CKB_MULTIPLIER), 0)?) + 1;
    let sudt_multiplier = U256::from(u64_from(load(SUDT_MULTIPLIER), 0)?) + 1;

    // A log_min_fulfillment encoded as N is translated to a minimum fulfillment of 2^N shannons
    let min_fulfillment = U256::from(1u128 << load(LOG_MIN_FULFILLMENT)[0]);
    Ok((
        terminal_lock,
        sudt_hash,
        is_sudt_to_ckb,
        ckb_multiplier,
        sudt_multiplier,
        min_fulfillment,
    ))
}
