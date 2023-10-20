import { BytesLike, PackParam, UnpackResult } from "@ckb-lumos/codec";
import { BI, BIish } from "@ckb-lumos/bi";
import { Cell } from "@ckb-lumos/base";
export declare function isValid(order: Cell): boolean;
export declare function create(data: PackableOrder, amount: BI): {
    cellOutput: {
        capacity: string;
        lock: {
            args: string;
            codeHash: string;
            hashType: import("@ckb-lumos/base").HashType;
        };
        type: import("@ckb-lumos/base").Script;
    };
    data: string;
};
export declare function cancel(order: Cell): {
    cellOutput: {
        capacity: string;
        lock: {
            codeHash: string;
            hashType: import("@ckb-lumos/base").HashType;
            args: string;
        };
        type: import("@ckb-lumos/base").Script | undefined;
    };
    data: string;
};
export declare function fulfill(order: Cell): {
    cellOutput: {
        capacity: string;
        lock: {
            codeHash: string;
            hashType: import("@ckb-lumos/base").HashType;
            args: string;
        };
        type: import("@ckb-lumos/base").Script | undefined;
    };
    data: string;
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