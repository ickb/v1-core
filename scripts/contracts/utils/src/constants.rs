use ckb_std::ckb_types::core::ScriptHashType;

// DAO

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#example
pub const DAO_CODE_HASH: [u8; 32] =
    from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e");
pub const DAO_HASH_TYPE: u8 = ScriptHashType::Type as u8;
pub const DAO_ARGS: [u8; 0] = [];

// Computed from the previous
pub const DAO_HASH: [u8; 32] =
    from_hex("0xcc77c4deac05d68ab5b26828f0bf4565a8d73113d7bb7e92b8362b8a74e58e58");

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#deposit
pub const DAO_DEPOSIT_DATA: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
pub const DAO_DEPOSIT_DATA_SIZE: usize = DAO_DEPOSIT_DATA.len();

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#calculation
pub const GENESIS_ACCUMULATED_RATE: u128 = 10_000_000_000_000_000; // 10^16 Genesis block accumulated rate

// UDT

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0025-simple-udt/0025-simple-udt.md#sudt-cell
pub const UDT_SIZE: usize = 16;

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0052-extensible-udt/0052-extensible-udt.md#deployment
pub const XUDT_CODE_HASH: [u8; 32] =
    from_hex("0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95");
pub const XUDT_HASH_TYPE: u8 = ScriptHashType::Data1 as u8;

// Hex utils

const fn from_hex(hex_string: &str) -> [u8; 32] {
    if hex_string.len() != 2 + 2 * 32
        || hex_string.as_bytes()[0] != ('0' as u8)
        || hex_string.as_bytes()[1] != ('x' as u8)
    {
        panic!("Invalid input hexadecimal string")
    }

    let mut result = [0u8; 32];
    let hb = hex_string.as_bytes();

    let mut i = 0;
    while i < 32 {
        result[i] = hex_value(hb[2 * i + 2]) * 16 + hex_value(hb[2 * i + 3]);

        i += 1;
    }

    return result;
}

const fn hex_value(hc: u8) -> u8 {
    const _0: u8 = '0' as u8;
    const _9: u8 = '9' as u8;
    const A: u8 = 'a' as u8;
    const F: u8 = 'f' as u8;
    match hc {
        _0..=_9 => hc - _0,
        A..=F => hc - A + 10,
        _ => panic!("Invalid input hexadecimal character"),
    }
}
