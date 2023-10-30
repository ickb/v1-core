import { BI } from "@ckb-lumos/bi";
import { Cell, HashType, HexString, Script } from "@ckb-lumos/base";
export declare function newLimitOrderUtils(limitOrderLock?: Script, sudtType?: Script): {
    create: (data: PackableOrder & {
        ckbAmount?: BI;
        sudtAmount?: BI;
    }) => {
        cellOutput: {
            capacity: string;
            lock: {
                args: string;
                codeHash: string;
                hashType: HashType;
            };
            type: Script;
        };
        data: string;
    };
    fulfill: (order: Cell, ckbAllowance: BI | undefined, sudtAllowance: BI | undefined) => Cell;
    cancel: (order: Cell) => {
        cellOutput: {
            capacity: string;
            lock: {
                codeHash: string;
                hashType: HashType;
                args: string;
            };
            type: Script | undefined;
        };
        data: string;
    };
    extract: (order: Cell) => {
        ckbAmount: BI;
        sudtAmount: BI;
        terminalLock: {
            codeHash: string;
            hashType: HashType;
            args: string;
        };
        sudtHash: string;
        isSudtToCkb: boolean;
        ckbMultiplier: BI;
        sudtMultiplier: BI;
    };
    limitOrderLock: {
        codeHash: string;
        hashType: HashType;
        args: string;
    };
    sudtType: {
        codeHash: string;
        hashType: HashType;
        args: string;
    };
    sudtHash: string;
};
export declare type PackableOrder = {
    terminalLock: {
        codeHash: HexString;
        hashType: HashType;
        args: HexString;
    };
    sudtHash: HexString;
    isSudtToCkb: boolean;
    ckbMultiplier: BI;
    sudtMultiplier: BI;
};
export declare const LimitOrderCodec: import("@ckb-lumos/codec/lib/base").BytesCodec<PackableOrder, PackableOrder>;
//# sourceMappingURL=limit_order.d.ts.map