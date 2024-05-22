use ckb_std::ckb_types::core::ScriptHashType;
use utils::from_hex;

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#example
pub const DAO_CODE_HASH: [u8; 32] =
    from_hex("0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e");
pub const DAO_HASH_TYPE: u8 = ScriptHashType::Type as u8;
pub const DAO_ARGS: [u8; 0] = [];

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#deposit
pub const DAO_DEPOSIT_DATA: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0];

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#calculation
pub const GENESIS_ACCUMULATED_RATE: u128 = 10_000_000_000_000_000; // 10^16 Genesis block accumulated rate

// https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0052-extensible-udt/0052-extensible-udt.md#deployment
pub const XUDT_CODE_HASH: [u8; 32] =
    from_hex("0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95");
pub const XUDT_HASH_TYPE: u8 = ScriptHashType::Data1 as u8;

// https://github.com/nervosnetwork/rfcs/blob/41a469a10cce2104656767944e9aba9a61ab497d/rfcs/0052-extensible-udt/0052-extensible-udt.md#owner-mode-update
pub const XUDT_ARGS_FLAGS: [u8; 4] = [0, 0, 0, 128]; // Flag 0x80000000

// iCKB deposit constants
pub const CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 1_000 * 100_000_000; // 1000 CKB
pub const CKB_MAXIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 1_000_000 * 100_000_000; // 1M CKB
pub const ICKB_SOFT_CAP_PER_DEPOSIT: u128 = 100_000 * 100_000_000; // 100_000 iCKB
