use ckb_std::error::SysError;

/// Error
#[repr(i8)]
pub enum Error {
    IndexOutOfBound = 1,
    ItemMissing,
    LengthNotEnough,
    Encoding,
    // Add customized errors here...
    NotEmptyArgs,
    DuplicatedMaster,
    InvalidAction,
    NonZeroPadding,
    InvalidRatio,
    InvalidCkbMinMatchLog,
    ConcaveRatio,
    BothRatioNull,
    DataTooLong,
    MissingUdtType,
    SameMaster,
    ScriptMisuse,
    DifferentInfo,
    InvalidMatch,
    DecreasingValue,
    AttemptToChangeFulfilled,
    InsufficientMatch,
    InvalidConfiguration,
}

impl From<SysError> for Error {
    fn from(err: SysError) -> Self {
        use SysError::*;
        match err {
            IndexOutOfBound => Self::IndexOutOfBound,
            ItemMissing => Self::ItemMissing,
            LengthNotEnough(_) => Self::LengthNotEnough,
            Encoding => Self::Encoding,
            Unknown(err_code) => panic!("unexpected sys error {}", err_code),
        }
    }
}
