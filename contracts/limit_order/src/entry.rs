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

const CKB_DECIMALS: u64 = 8;

fn validate(index: usize, script: &Script) -> Result<(), Error> {
    // Validate input.
    let in_script = load_cell_lock(index, Source::Input)?;
    let (terminal_lock, sudt_hash, is_sudt_to_ckb, ckb_multiplier, sudt_multiplier) =
        extract_args_data(&script)?;
    let (in_ckb_amount, in_sudt_amount, _, _) = extract_amounts(index, Source::Input, sudt_hash)?;

    // Validate output.
    let out_script = load_cell_lock(index, Source::Output)?;
    if out_script.as_slice() != in_script.as_slice()
        && out_script.as_slice() != terminal_lock.as_slice()
    {
        return Err(Error::InvalidOutputLock);
    }

    let (out_ckb_amount, out_sudt_amount, script_type, cell_data_len) =
        extract_amounts(index, Source::Output, sudt_hash)?;

    // Output lock is given to UI as address, so the output lock should not use additional cell data.
    match (script_type, cell_data_len) {
        (ScriptType::None, 0) => (),
        (ScriptType::SUDT, 16) => (),
        _ => return Err(Error::InvalidInputType),
    };

    // Check that limit order does not lose value.
    // Note on Overflow: u128 quantities represented with u256, no overflow is possible.
    if in_ckb_amount * ckb_multiplier + in_sudt_amount * sudt_multiplier
        > out_ckb_amount * ckb_multiplier + out_sudt_amount * sudt_multiplier
    {
        return Err(Error::DecreasingValue);
    }

    // Validate limit order fulfillment while preventing DoS and leaving enough CKB for terminal lock state rent.
    // SUDT -> CKB

    let is_owner_mode = || {
        QueryIter::new(load_cell_lock, Source::Input)
            .any(|s| s.as_slice() == terminal_lock.as_slice())
    };

    let one_hundred_ckb = U256::from(100 * 10 ^ CKB_DECIMALS); // 100 CKB
    if is_sudt_to_ckb {
        // Terminal state.
        if out_script.as_slice() == terminal_lock.as_slice() && script_type == ScriptType::None {
            return Ok(());
        }

        // Partially fulfilled.
        if out_script.as_slice() == in_script.as_slice()
            && script_type == ScriptType::SUDT
            // DoS prevention: 100 CKB is the minimum partial fulfillment.
            && in_ckb_amount + one_hundred_ckb  <= out_ckb_amount
        {
            return Ok(());
        }

        // Recovery using owner lock.
        if out_script.as_slice() == terminal_lock.as_slice() && is_owner_mode() {
            return Ok(());
        }

        return Err(Error::InvalidAction);
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
            && in_sudt_amount * sudt_multiplier + one_hundred_ckb * ckb_multiplier
                <= out_sudt_amount * sudt_multiplier
        {
            return Ok(());
        }

        // Recovery using owner lock.
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

#[repr(usize)]
enum Role {
    TerminalLockCodeHash = 0,
    TerminalLockHashType,
    TerminalLockArgs,
    SudtHash,
    IsSudtToCkb,
    CkbMultiplier,
    SudtMultiplier,
}
pub fn extract_args_data(script: &Script) -> Result<(Script, [u8; 32], bool, U256, U256), Error> {
    let args: Bytes = script.args().unpack();
    let mut lengths: [usize; 7] = [32, 1, 0, 32, 1, 8, 8];
    let minimum_length: usize = lengths.iter().sum();
    if args.len() < minimum_length {
        return Err(Error::ArgsTooShort);
    }
    lengths[Role::TerminalLockArgs as usize] = args.len() - minimum_length;

    let mut data: [&[u8]; 7] = Default::default();
    let mut x0: usize = 0;
    for (index, length) in lengths.iter().enumerate() {
        let x1 = x0 + length;
        data[index] = &args[x0..x1];
        x0 = x1;
    }

    let terminal_lock = ScriptBuilder::default()
        .code_hash(Byte32::new_unchecked(
            data[Role::TerminalLockCodeHash as usize].to_vec().into(),
        ))
        .hash_type(data[Role::TerminalLockHashType as usize][0].into())
        .args(Bytes::from(data[Role::TerminalLockArgs as usize].to_vec()).pack())
        .build();

    let sudt_hash: [u8; 32] = data[Role::SudtHash as usize].try_into().unwrap();
    let is_sudt_to_ckb = data[Role::IsSudtToCkb as usize][0] != 0;

    // Multipliers are only positive numbers, so they are encoded subtracting 1 to avoid the zero value.
    // Note on Overflow: u64 quantities represented with u256, no overflow is possible.
    let ckb_multiplier = U256::from(u64_from(data[Role::CkbMultiplier as usize], 0)?) + 1;
    let sudt_multiplier = U256::from(u64_from(data[Role::SudtMultiplier as usize], 0)?) + 1;

    Ok((
        terminal_lock,
        sudt_hash,
        is_sudt_to_ckb,
        ckb_multiplier,
        sudt_multiplier,
    ))
}
