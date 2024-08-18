// https://github.com/nervosnetwork/rfcs/blob/41a469a10cce2104656767944e9aba9a61ab497d/rfcs/0052-extensible-udt/0052-extensible-udt.md#owner-mode-update
pub const XUDT_ARGS_FLAGS: [u8; 4] = [0, 0, 0, 128]; // Flag 0x80000000

// iCKB deposit constants
pub const CKB_MINIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 1_000 * 100_000_000; // 1000 CKB
pub const CKB_MAXIMUM_UNOCCUPIED_CAPACITY_PER_DEPOSIT: u64 = 1_000_000 * 100_000_000; // 1M CKB
pub const ICKB_SOFT_CAP_PER_DEPOSIT: u128 = 100_000 * 100_000_000; // 100_000 iCKB
