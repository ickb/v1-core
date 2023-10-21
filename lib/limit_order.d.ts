import { BytesLike, PackParam, UnpackResult } from "@ckb-lumos/codec";
import { BI, BIish } from "@ckb-lumos/bi";
import { Cell, Script } from "@ckb-lumos/base";
export declare function newLimitOrderUtils(sudtType?: Script): {
    create: (data: PackableOrder & {
        ckbAmount?: BI;
        sudtAmount?: BI;
    }) => {
        cellOutput: {
            capacity: string;
            lock: {
                args: string;
                codeHash: string;
                hashType: import("@ckb-lumos/base").HashType;
            };
            type: Script;
        };
        data: string;
    };
    fulfill: (order: Cell, ckbAllowance: BI | undefined, sudtAllowance: BI | undefined) => Cell;
    cancel: (order: Cell) => {
        cellOutput: {
            capacity: string;
            lock: Script;
            type: Script | undefined;
        };
        data: string;
    };
};
export declare const BooleanCodec: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<boolean, boolean>;
export declare const PositiveUint64LE: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<BI, BIish>;
export declare const PartialLimitOrderCodec: import("@ckb-lumos/codec/lib/molecule/layout").ObjectCodec<{
    sudtHash: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<string, BytesLike>;
    isSudtToCkb: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<boolean, boolean>;
    sudtMultiplier: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<BI, BIish>;
    ckbMultiplier: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<BI, BIish>;
    codeHash: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<string, BytesLike>;
    hashType: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<import("@ckb-lumos/base").HashType, import("@ckb-lumos/base").HashType>;
}> & import("@ckb-lumos/codec/lib/base").Fixed;
export declare const ArgsLimitOrderCodec: import("@ckb-lumos/codec/lib/base").BytesCodec<{
    args: string;
}, {
    args: BytesLike;
}>;
export type PackableOrder = PackParam<typeof PartialLimitOrderCodec> & PackParam<typeof ArgsLimitOrderCodec>;
export type UnpackedOrder = UnpackResult<typeof PartialLimitOrderCodec> & UnpackResult<typeof ArgsLimitOrderCodec>;
export declare const LimitOrderCodec: import("@ckb-lumos/codec/lib/base").BytesCodec<UnpackedOrder, PackableOrder>;
//# sourceMappingURL=limit_order.d.ts.map