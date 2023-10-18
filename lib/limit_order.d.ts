import { BytesLike, PackParam, UnpackResult } from "@ckb-lumos/codec";
import { BI } from "@ckb-lumos/bi";
import { Cell } from "@ckb-lumos/base";
export declare function terminalCellOf(data: UnpackedOrder, inCkb: BI, inIckb: BI): {
    cell: {
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
    outCkb: BI;
    outIckb: BI;
};
export declare function createOrderCell(data: PackableOrder, amount: BI): Promise<{
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
}>;
export declare function deleteOrderCell(orderCell: Cell): Promise<{
    cellOutput: {
        capacity: string;
        lock: {
            codeHash: string;
            hashType: import("@ckb-lumos/base").HashType;
            args: string;
        };
        type: import("@ckb-lumos/base").Script;
    };
    data: string;
}>;
export declare const BooleanCodec: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<boolean, boolean>;
export declare const PartialLimitOrderCodec: import("@ckb-lumos/codec/lib/molecule/layout").ObjectCodec<{
    sudtHash: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<string, BytesLike>;
    isSudtToCkb: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<boolean, boolean>;
    sudtMultiplier: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<BI, import("@ckb-lumos/bi").BIish>;
    ckbMultiplier: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<BI, import("@ckb-lumos/bi").BIish>;
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