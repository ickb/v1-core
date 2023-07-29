use crate::error::Error;
use utils::{u128_from, u64_from};
use core::result::Result;
use primitive_types::U256;

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
    // Validate input.
    let in_script = load_cell_lock(index, Source::Input)?;
    let (
        sudt_hash,
        is_sudt_to_ckb,
        sudt_multiplier,
        ckb_multiplier,
        terminal_lock,
    ) = extract_args_data(&script)?;
    let (in_ckb_amount, in_sudt_amount, _, _) = extract_amounts(index, Source::Input, sudt_hash)?;

    // Validate output.
    let out_script = load_cell_lock(index, Source::Output)?;
    if out_script.as_slice() != in_script.as_slice()
        && out_script.as_slice() != terminal_lock.as_slice()
    {
        return Err(Error::Encoding);
    }

    let (out_ckb_amount, out_sudt_amount, script_type, cell_data_len) =
        extract_amounts(index, Source::Output, sudt_hash)?;

    match (script_type, cell_data_len) {
        (ScriptType::None, 0) => (),
        // Output lock is given to UI as address, so the output lock should not use additional cell data.
        (ScriptType::SUDT, 16) => (),
        _ => return Err(Error::Encoding),
    };

    // Check that limit order does not lose value.
    // Note on Overflow: u128 quantities represented with u256, no overflow is possible.
    if U256::from(in_ckb_amount) * U256::from(ckb_multiplier)
        + U256::from(in_sudt_amount) * U256::from(sudt_multiplier)
        > U256::from(out_ckb_amount) * U256::from(ckb_multiplier)
            + U256::from(out_sudt_amount) * U256::from(sudt_multiplier)
    {
        return Err(Error::DecreasingValue);
    }

    // Validate limit order fulfillment while preventing DoS and leaving enough CKB for terminal lock state rent.
    // SUDT -> CKB

    let is_owner_mode = || {
        QueryIter::new(load_cell_lock, Source::Input)
            .any(|s| s.as_slice() == terminal_lock.as_slice())
    };

    if is_sudt_to_ckb {
        // Terminal state.
        if out_script.as_slice() == terminal_lock.as_slice() && script_type == ScriptType::None {
            return Ok(());
        }

        // Partially fulfilled.
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::SUDT
            // DoS prevention: 100 CKB is the minimum partial fulfillment.
            && in_ckb_amount + 100 <= out_ckb_amount
        {
            return Ok(());
        }

        // Recovery using owner lock.
        if out_script.as_slice() == terminal_lock.as_slice() && is_owner_mode() {
            return Ok(());
        }

        return Err(Error::Encoding);
    } else {
        // CKB -> SUDT
        // Terminal state.
        if out_script.as_slice() == terminal_lock.as_slice()
            && script_type == ScriptType::SUDT
            && load_cell_capacity(index, Source::Output)
                == load_cell_occupied_capacity(index, Source::Output)
        {
            return Ok(());
        }

        // Partially fulfilled.
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::SUDT
            // DOS prevention: the equivalent of 100 CKB is the minimum partial fulfillment.
            // Note on Overflow: u128 quantities represented with u256, no overflow is possible.
            && U256::from(in_sudt_amount) * U256::from(sudt_multiplier) 
            + U256::from(100 * ckb_multiplier) 
            <= U256::from(out_sudt_amount) * U256::from(sudt_multiplier)
        {
            return Ok(());
        }

        // Recovery using owner lock.
        if out_script.as_slice() == terminal_lock.as_slice() && is_owner_mode() {
            return Ok(());
        }

        return Err(Error::Encoding);
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
) -> Result<(u64, u128, ScriptType, usize), Error> {
    let ckb_amount = load_cell_capacity(index, Source::Input)?;

    let data = load_cell_data(index, source)?;

    let (sudt_amount, script_type) = match load_cell_type_hash(index, source)? {
        None => (0, ScriptType::None),
        Some(h) if h == sudt_hash => (u128_from(&data, 0)?, ScriptType::SUDT),
        Some(_) => (0, ScriptType::Unknown),
    };

    let cell_data_len = data.len();

    return Ok((ckb_amount, sudt_amount, script_type, cell_data_len));
}

pub fn extract_args_data(script: &Script) -> Result<([u8; 32], bool, u64, u64, Script), Error> {
    let args: Bytes = script.args().unpack();

    if args.len() < (32 + 1 + 8 + 8 + 32 + 1) {
        return Err(Error::Encoding);
    }

    let sudt_hash: [u8; 32] = args[0..32].try_into().unwrap();
    let is_sudt_to_ckb = args[32] != 0;
    let sudt_multiplier = u64_from(&args, 32 + 1)?;
    let ckb_multiplier = u64_from(&args, 32 + 1 + 8)?;

    let script = ScriptBuilder::default()
        .code_hash(Byte32::new_unchecked(
            args[32 + 1 + 8 + 8..32 + 1 + 8 + 8 + 32].to_vec().into(),
        ))
        .hash_type(args[32 + 1 + 8 + 8 + 32].into())
        .args(Bytes::from(args[32 + 1 + 8 + 8 + 32 + 1..].to_vec()).pack())
        .build();

    Ok((
        sudt_hash,
        is_sudt_to_ckb,
        sudt_multiplier,
        ckb_multiplier,
        script,
    ))
}
