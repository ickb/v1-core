use core::result::Result;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, packed::Byte32, prelude::*},
    debug,
    high_level::*,
    syscalls::SysError,
};

use crate::error::Error;

//Current code problems:
// (TO-DO-1) how to express NervosDAO type hash in a way that works both in testing and production?
// (TO-DO-2) load_cell_capacity and load_cell_occupied_capacity return an u64 representing a CKB amount, is it expressed in shannons?
// (TO-DO-3) if the transaction has no output, how to get current block header?

pub fn main() -> Result<(), Error> {
    let script = load_script()?;
    let args: Bytes = script.args().unpack();
    debug!("script args is {:?}", args);

    if !args.is_empty() {
        return Err(Error::NotEmptyArgs);
    }

    let code_hash = script.code_hash();

    let (in_ickb, in_sdc) = count(Source::Input, &code_hash)?;
    let (out_ickb, out_sdc) = count(Source::Output, &code_hash)?;

    if in_ickb + SDC_CAPACITY * out_sdc < out_ickb + SDC_CAPACITY * in_sdc {
        return Err(Error::Amount);
    }

    Ok(())
}

const NERVOS_DAO_CODE_HASH: [u8; 32] = [0u8; 32]; // (TO-DO-1)////////////////////////////////////

fn count(source: Source, ickb_code_hash: &Byte32) -> Result<(u64, u64), Error> {
    let (withdrawing_accumulated_rate, sdc_equivalent_capacity) = sdc_data()?;

    let mut total_token_amount = 0;
    let mut total_sdc_count = 0;

    for (index, type_hash) in QueryIter::new(load_cell_type_hash, source).enumerate() {
        match type_hash {
            None => (),
            Some(type_hash) if type_hash.as_slice() == ickb_code_hash.as_slice() => {
                total_token_amount += extract_ickb_amount(index, source)?;

                ickb_extra_checks(index, source, ickb_code_hash)?
            }
            Some(type_hash)
                if type_hash.as_slice() == NERVOS_DAO_CODE_HASH.as_slice()
                    && cell_has_lock(index, source, ickb_code_hash)? =>
            {
                let equivalent_capacity =
                    maximum_withdrawable(index, source, withdrawing_accumulated_rate)?;

                total_sdc_count += (sdc_equivalent_capacity <= equivalent_capacity) as u64;

                sdc_extra_checks(index, source, equivalent_capacity, sdc_equivalent_capacity)?
            }
            Some(_) => (),
        };
    }

    Ok((total_token_amount, total_sdc_count))
}

fn maximum_withdrawable(
    index: usize,
    source: Source,
    withdrawing_accumulated_rate: u64,
) -> Result<u64, SysError> {
    if source == Source::Output {
        return load_cell_capacity(index, source);
    }

    let equivalent_capacity = maximum_withdrawable_(
        load_cell_capacity(index, source)?, // (TO-DO-2)////////////////////////////////////
        load_cell_occupied_capacity(index, source)?, // (TO-DO-2)///////////////////
        extract_accumulated_rate(index, source)?,
        withdrawing_accumulated_rate,
    );

    Ok(equivalent_capacity)
}

//Standard Deposit Cell data
const SDC_CAPACITY: u64 = 1_000_000_000_000; // 10000 CKB in shannons (TO-DO-2)//////////////////////////
const SDC_OCCUPIED_CAPACITY: u64 = 10_000_000_000; // 100 CKB in shannons (TO-DO-2)/////////////////////
const SDC_ACCUMULATED_RATE: u64 = 10_000_000_000_000_000; //Genesis block accumulated rate

fn sdc_data() -> Result<(u64, u64), Error> {
    let withdrawing_accumulated_rate = extract_accumulated_rate(0, Source::Output)?; // (TO-DO-3)//////
    let sdc_equivalent_capacity = maximum_withdrawable_(
        SDC_CAPACITY,
        SDC_OCCUPIED_CAPACITY,
        SDC_ACCUMULATED_RATE,
        withdrawing_accumulated_rate,
    );

    Ok((withdrawing_accumulated_rate, sdc_equivalent_capacity))
}

fn maximum_withdrawable_(
    capacity: u64,
    occupied_capacity: u64,
    deposit_accumulated_rate: u64,
    withdrawing_accumulated_rate: u64,
) -> u64 {
    (u128::from(capacity - occupied_capacity) * u128::from(withdrawing_accumulated_rate)
        / u128::from(deposit_accumulated_rate)) as u64
        + occupied_capacity
}

fn ickb_extra_checks(index: usize, source: Source, ickb_code_hash: &Byte32) -> Result<(), Error> {
    if source == Source::Input {
        return Ok(());
    }

    if cell_has_lock(index, source, ickb_code_hash)? {
        return Err(Error::InvalidLock);
    }

    Ok(())
}

fn sdc_extra_checks(
    _index: usize,
    source: Source,
    equivalent_capacity: u64,
    sdc_equivalent_capacity: u64,
) -> Result<(), Error> {
    if source == Source::Input {
        return Ok(());
    }

    if equivalent_capacity < sdc_equivalent_capacity {
        return Err(Error::DepositTooSmall);
    }

    if equivalent_capacity > sdc_equivalent_capacity + sdc_equivalent_capacity / 1000 {
        return Err(Error::DepositTooBig);
    }

    Ok(())
}

fn cell_has_lock(index: usize, source: Source, code_hash: &Byte32) -> Result<bool, Error> {
    Ok(load_cell_lock_hash(index, source)?.as_slice() == code_hash.as_slice())
}

const ICKB_DATA_LEN: usize = 8; // (TO-DO-2)////////////////////////////////////

fn extract_ickb_amount(index: usize, source: Source) -> Result<u64, Error> {
    let data = load_cell_data(index, source)?;

    if data.len() < ICKB_DATA_LEN {
        return Err(Error::Encoding);
    }

    let mut buffer = [0u8; ICKB_DATA_LEN];
    buffer.copy_from_slice(&data[0..ICKB_DATA_LEN]);
    let amount = u64::from_le_bytes(buffer);

    Ok(amount)
}

fn extract_accumulated_rate(index: usize, source: Source) -> Result<u64, SysError> {
    let dao_data = load_header(index, source)?.raw().dao();

    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(&dao_data.as_slice()[8..16]);
    let accumulated_rate = u64::from_le_bytes(buffer);

    Ok(accumulated_rate)
}
