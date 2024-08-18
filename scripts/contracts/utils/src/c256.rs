use core::ops::{Add, Mul, Sub};
use primitive_types::U256;

// C256 wraps U256 and only uses checked operations
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd)]
pub struct C256(U256);

impl C256 {
    pub fn is_zero(&self) -> bool {
        self.0.is_zero()
    }
}

impl Add for C256 {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        match self.0.overflowing_add(other.0) {
            (_, true) => panic!("Overflow"),
            (val, _) => Self(val),
        }
    }
}

impl Sub for C256 {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        match self.0.overflowing_sub(other.0) {
            (_, true) => panic!("Overflow"),
            (val, _) => Self(val),
        }
    }
}

impl Mul for C256 {
    type Output = Self;

    fn mul(self, other: Self) -> Self {
        match self.0.overflowing_mul(other.0) {
            (_, true) => panic!("Overflow"),
            (val, _) => Self(val),
        }
    }
}

impl From<u64> for C256 {
    fn from(item: u64) -> Self {
        Self(U256::from(item))
    }
}

impl From<u128> for C256 {
    fn from(item: u128) -> Self {
        Self(U256::from(item))
    }
}
