use crate::error::Error;
use ckb_utils::{from_hex, u128_from, u64_from};
use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{
        packed::{Byte32, Bytes, Script, ScriptBuilder},
        prelude::*,
    },
    high_level::*,
};

pub fn main() -> Result<(), Error> {
    let current_script = load_script()?;
    let script_code_hash = current_script.code_hash();
    let script_hash_type = current_script.hash_type();
    let script_args = current_script.args();

    let limit_order_iterator = || {
        QueryIter::new(load_cell_lock, Source::Input)
            .enumerate()
            .filter(|(_, s)| {
                s.code_hash().as_slice() == script_code_hash.as_slice()
                    && s.hash_type() == script_hash_type
            })
    };

    // Optimization: execute only first occurrence of limit order lock.
    // Check if the executing script group it's the first limit order lock in input.
    // If it isn't, return ok. If it is, validate the transaction.
    let is_first_limit_order = limit_order_iterator()
        //Next takes first element of limit orders iterator
        .next()
        .map_or(false, |(_, s)| {
            //Check if it is part of the current script group
            s.args().as_slice() == script_args.as_slice()
        });

    if !is_first_limit_order {
        return Ok(());
    }

    for (index, script) in limit_order_iterator() {
        validate(index, &script)?;
    }

    Ok(())
}

fn validate(index: usize, script: &Script) -> Result<(), Error> {
    // Validate input.
    let in_script = load_cell_lock(index, Source::Input)?;
    let (in_ckb_amount, in_ickb_amount, _, _) = extract_amounts(index, Source::Input)?;
    let (is_withdrawal, exchange_ratio, terminal_lock) = extract_args_data(&script)?;

    // Validate output.
    let out_script = load_cell_lock(index, Source::Output)?;
    if out_script.as_slice() != in_script.as_slice()
        && out_script.as_slice() != terminal_lock.as_slice()
    {
        return Err(Error::Encoding);
    }

    let (out_ckb_amount, out_ickb_amount, script_type, cell_data_len) =
        extract_amounts(index, Source::Input)?;

    match (script_type, cell_data_len) {
        (ScriptType::None, 0) => (),
        // Output lock is given to UI as address, so the output lock should not use additional cell data.
        (ScriptType::ICKB, 16) => (),
        _ => return Err(Error::Encoding),
    };

    // Check that limit order does not lose value.
    // Note on Overflow: u64 quantities represented with u128, no overflow is possible.
    let in_value =
        u128::from(in_ckb_amount) + in_ickb_amount * u128::from(exchange_ratio) / 10 ^ 16;
    let out_value =
        u128::from(out_ckb_amount) + out_ickb_amount * u128::from(exchange_ratio) / 10 ^ 16;
    if in_value > out_value {
        return Err(Error::DecreasingValue);
    }

    // Validate limit order fulfillment while preventing DoS and leaving enough CKB for terminal lock state rent.
    // iCKB -> CKB

    let is_owner_mode = || {
        QueryIter::new(load_cell_lock, Source::Input)
            .any(|s| s.as_slice() == terminal_lock.as_slice())
    };

    if is_withdrawal {
        // Terminal state.
        if out_script.as_slice() == terminal_lock.as_slice() && script_type == ScriptType::None {
            return Ok(());
        }

        // Partially fulfilled.
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::ICKB
            // DoS prevention: 1000 CKB is the minimum partial fulfillment.
            && in_ckb_amount + 1000 <= out_ckb_amount
        {
            return Ok(());
        }

        // Recovery using owner lock.
        if out_script.as_slice() == terminal_lock.as_slice() && is_owner_mode() {
            return Ok(());
        }

        return Err(Error::Encoding);
    } else {
        // CKB -> iCKB
        // Terminal state.
        if out_script.as_slice() == terminal_lock.as_slice()
            && script_type == ScriptType::ICKB
            && load_cell_capacity(index, Source::Output)
                == load_cell_occupied_capacity(index, Source::Output)
        {
            return Ok(());
        }

        // Partially fulfilled.
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::ICKB
            // DOS prevention: 1000 iCKB is the minimum partial fulfillment.
            && in_ickb_amount + 1000 <= out_ickb_amount
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
    ICKB,
}

fn extract_amounts(index: usize, source: Source) -> Result<(u64, u128, ScriptType, usize), Error> {
    let ckb_amount = load_cell_capacity(index, Source::Input)?;

    let data = load_cell_data(index, source)?;

    let (ickb_amount, script_type) = match load_cell_type_hash(index, source)? {
        None => (0, ScriptType::None),
        Some(ICKB_TOKEN_HASH) => (u128_from(&data, 0)?, ScriptType::ICKB),
        Some(_) => (0, ScriptType::Unknown),
    };

    let cell_data_len = data.len();

    return Ok((ckb_amount, ickb_amount, script_type, cell_data_len));
}

//TO BE CALCULATED ////////////////////////////////////////////////////////////////////////////////////////
const ICKB_TOKEN_HASH: [u8; 32] =
    from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2a");

pub fn extract_args_data(script: &Script) -> Result<(bool, u64, Script), Error> {
    let args: ckb_std::ckb_types::bytes::Bytes = script.args().unpack();

    if args.len() < (1 + 8 + 32 + 1) {
        return Err(Error::Encoding);
    }

    let is_withdrawal = args[0] != 0;
    let exchange_ratio = u64_from(&args, 1)?;

    let script = ScriptBuilder::default()
        .code_hash(Byte32::new_unchecked(args[1 + 8..1 + 8 + 32].into()))
        .hash_type(args[1 + 8 + 32].into())
        .args(Bytes::new_unchecked(args[1 + 8 + 32 + 1..].into()))
        .build();

    Ok((is_withdrawal, exchange_ratio, script))
}
