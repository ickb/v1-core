import { Byte32, HashType as HashTypeCodec, createFixedHexBytesCodec } from "@ckb-lumos/base/lib/blockchain";
import { createBytesCodec, createFixedBytesCodec } from "@ckb-lumos/codec";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule";
import { Uint128LE, Uint64LE, Uint8 } from "@ckb-lumos/codec/lib/number";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi";
import { TransactionSkeleton, TransactionSkeletonType } from "@ckb-lumos/helpers";
import { Cell, HashType, HexString } from "@ckb-lumos/base";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import {
    Assets, BooleanCodec, I8Cell, I8Script, addAssetsFunds, addCells,
    defaultScript, i8ScriptPadding, scriptEq, simpleSifter
} from "@ickb/lumos-utils";
import { ickbSudtType } from "./ickb_logic";

export type LimitOrder = PackableOrderArgs & {
    cell: I8Cell,
    terminalLock: I8Script,
    sudtAmount: BI,
    ckbAmount: BI
};

export const errorCkbAllowanceTooLow = "Not enough ckb allowance to partially fulfill a limit order";
export const errorSudtAllowanceTooLow = "Not enough SUDT allowance to partially fulfill a limit order";
export const errorTerminalLockNotFound = "Not found an input cell with terminal lock in the transaction";
export function limitOrder(sudtType: I8Script = i8ScriptPadding) {
    if (sudtType == i8ScriptPadding) {
        sudtType = ickbSudtType();
    }
    const orderLock = limitOrderLock();
    const sudtHash = computeScriptHash(sudtType);

    function create(
        tx: TransactionSkeletonType,
        o: Omit<PackableOrderArgs, "revision"> & { ckbAmount?: BI, sudtAmount?: BI }
    ) {
        let c = I8Cell.from({
            lock: I8Script.from({ ...orderLock, args: hexify(LimitOrderArgsCodec.pack({ ...o, revision: 0 })) }),
            type: sudtType,
            data: hexify(Uint128LE.pack((o.sudtAmount ?? 0)))
        });

        if (o.ckbAmount) {
            c = I8Cell.from({
                ...c,
                capacity: BI.from(c.cellOutput.capacity).add(o.ckbAmount).toHexString(),
            });
        }

        return addCells(tx, "append", [], [c]);
    }

    function fulfill(
        tx: TransactionSkeletonType,
        o: LimitOrder,
        ckbAllowance: BI | undefined,
        sudtAllowance: BI | undefined
    ) {
        const { fulfillment } = satisfy(o, ckbAllowance, sudtAllowance);
        return addCells(tx, "matched", [o.cell], [fulfillment]);
    }

    function satisfy(
        o: LimitOrder,
        ckbAllowance: BI | undefined,
        sudtAllowance: BI | undefined
    ) {
        let fulfillment = I8Cell.from({
            lock: o.terminalLock,
            type: sudtType,
            data: "0x00000000000000000000000000000000",
        });

        // Try to fulfill the order completely
        let isComplete = true;
        if (o.isSudtToCkb) {
            const outSudt = BI.from(0);
            const outCkb = calculate(o.sudtMultiplier, o.ckbMultiplier, o.sudtAmount, o.ckbAmount, outSudt);

            fulfillment = I8Cell.from({
                ...fulfillment,
                capacity: outCkb.toHexString(),
                type: undefined,
                data: "0x"
            });
            if (!ckbAllowance || outCkb.sub(o.ckbAmount).lte(ckbAllowance)) {
                return { fulfillment, isComplete };
            }
        } else {
            const outCkb = BI.from(fulfillment.cellOutput.capacity);
            const outSudt = calculate(o.ckbMultiplier, o.sudtMultiplier, o.ckbAmount, o.sudtAmount, outCkb);

            fulfillment = I8Cell.from({
                ...fulfillment,
                data: hexify(Uint128LE.pack(outSudt))
            });
            if (!sudtAllowance || outSudt.sub(o.sudtAmount).lte(sudtAllowance)) {
                return { fulfillment, isComplete };
            }
        }

        // Allowance limits the order fulfillment, so the output cell is a still a limit order
        isComplete = false;
        let outCkb: BI;
        let outSudt: BI;
        if (o.isSudtToCkb) {
            // DoS prevention: 100 CKB is the minimum partial fulfillment.
            if (ckbAllowance!.lt(parseUnit("100", "ckb"))) {
                throw Error(errorCkbAllowanceTooLow);
            }
            outCkb = o.ckbAmount.add(ckbAllowance!)
            outSudt = calculate(o.ckbMultiplier, o.sudtMultiplier, o.ckbAmount, o.sudtAmount, outCkb);
        } else {
            // DOS prevention: the SUDT equivalent of 100 CKB is the minimum partial fulfillment.
            if (sudtAllowance!.mul(o.sudtMultiplier).lt(parseUnit("100", "ckb").mul(o.ckbMultiplier))) {
                throw Error(errorSudtAllowanceTooLow);
            }
            outSudt = o.sudtAmount.add(sudtAllowance!);
            outCkb = calculate(o.sudtMultiplier, o.ckbMultiplier, o.sudtAmount, o.ckbAmount, outSudt);
        }

        fulfillment = I8Cell.from({
            lock: o.cell.cellOutput.lock,
            type: sudtType,
            capacity: outCkb.toHexString(),
            data: hexify(Uint128LE.pack(outSudt))
        });
        return { fulfillment, isComplete };
    }

    function cancel(tx: TransactionSkeletonType, o: LimitOrder, validate: boolean = true) {
        const cell = I8Cell.from({ ...o.cell, lock: o.terminalLock });
        if (validate && !tx.inputs.some(c => scriptEq(c.cellOutput.lock, o.terminalLock))) {
            throw Error(errorTerminalLockNotFound);
        }
        return addCells(tx, "matched", [o.cell], [cell]);
    }

    function _lockExpander(order: Cell) {
        const { lock, type } = order.cellOutput;
        const i8lock = I8Script.from({ ...orderLock, args: lock.args });

        //Validate limit order lock
        if (!scriptEq(lock, i8lock)) {
            return undefined;
        }

        try {
            const o = LimitOrderArgsCodec.unpack(lock.args);

            //Validate sudt type
            if ((type && !scriptEq(type, sudtType)) || o.sudtHash !== sudtHash) {
                return undefined;
            }
        } catch (e: any) {
            //Validate revision in the Codec itself
            if (e && e.message === errorInvalidOrderRevision) {
                return undefined;
            }
            throw e;
        }

        return i8lock;
    }

    function sifter(inputs: readonly Cell[], accountLock?: I8Script, sort?: "asc" | "desc") {
        const { capacities, sudts, notSimples } = simpleSifter(inputs, sudtType, _lockExpander);

        let orders: LimitOrder[] = capacities.concat(sudts).map(cell => {
            const { lock, type, capacity } = cell.cellOutput;

            //Validation is already done in expander
            const o = LimitOrderArgsCodec.unpack(lock.args);
            return {
                cell,
                ...o,
                terminalLock: I8Script.from({ ...i8ScriptPadding, ...o.terminalLock }),
                sudtAmount: type ? Uint128LE.unpack(cell.data) : BI.from(0),
                ckbAmount: BI.from(capacity)
            };
        });

        if (accountLock) {
            orders = orders.filter(o => scriptEq(o.terminalLock, accountLock));
        }

        const ckb2SudtOrders: typeof orders = [];
        const sudt2CkbOrders: typeof orders = [];
        for (const order of orders) {
            if (order.isSudtToCkb) {
                sudt2CkbOrders.push(order);
            } else {
                ckb2SudtOrders.push(order);
            }
        }

        if (sort) {
            sudt2CkbOrders.sort(sort === "asc" ? sudt2CkbRatioCompare : (o0, o1) => sudt2CkbRatioCompare(o1, o0));
            ckb2SudtOrders.sort(sort === "asc" ? (o0, o1) => sudt2CkbRatioCompare(o1, o0) : sudt2CkbRatioCompare);
        }

        return {
            ckb2SudtOrders,
            sudt2CkbOrders,
            notOrders: notSimples
        };
    }

    function isValid(order: Cell) {
        return !!_lockExpander(order);
    }

    return {
        sudtType, sudtHash, limitOrderLock: orderLock,
        create, fulfill, cancel,
        satisfy, sifter, isValid
    }
}

export function sudt2CkbRatioCompare(
    o0: LimitOrder,
    o1: LimitOrder
): number {
    if (o0.ckbMultiplier.eq(o1.ckbMultiplier)) {
        return o0.sudtMultiplier.sub(o1.sudtMultiplier).toNumber();
    }

    if (o0.sudtMultiplier.eq(o1.sudtMultiplier)) {
        return o1.ckbMultiplier.sub(o0.ckbMultiplier).toNumber();
    }

    // Idea: o0.Sudt2CkbRatio - o1.Sudt2CkbRatio
    // ~ o0.sudtMultiplier / o0.ckbMultiplier - o1.sudtMultiplier / o1.ckbMultiplier
    // order equivalent to:
    // ~ o0.sudtMultiplier * o1.ckbMultiplier - o1.sudtMultiplier * o0.ckbMultiplier 
    return o0.sudtMultiplier.mul(o1.ckbMultiplier)
        .sub(o1.sudtMultiplier.mul(o0.ckbMultiplier))
        .toNumber();
}

export function limitOrderFundAdapter(
    assets: Assets,
    ckb2SudtOrders: readonly LimitOrder[],
    sudt2CkbOrders: readonly LimitOrder[],
): Assets {
    const unavailableFunds = [
        TransactionSkeleton()
            .update("inputs", i => i
                .push(...ckb2SudtOrders.map(c => c.cell))
                .push(...sudt2CkbOrders.map(c => c.cell)))
    ];
    return addAssetsFunds(assets, undefined, unavailableFunds)
}

export function limitOrderLock() {
    return defaultScript("LIMIT_ORDER");
}

// Limit order rule on non decreasing value:
// min bOut such that aM * aIn + bM * bIn <= aM * aOut + bM * bOut
// bOut = (aM * (aIn - aOut) + bM * bIn) / bM
// But integer divisions truncate, so we need to round to the upper value
// bOut = (aM * (aIn - aOut) + bM * bIn + bM - 1) / bM
// bOut = (aM * (aIn - aOut) + bM * (bIn + 1) - 1) / bM
function calculate(aM: BI, bM: BI, aIn: BI, bIn: BI, aOut: BI) {
    return aM.mul(aIn.sub(aOut))
        .add(bM.mul(bIn.add(1)).sub(1))
        .div(bM);
}

const PositiveUint64LE = createFixedBytesCodec<BI, BIish>(
    {
        byteLength: Uint64LE.byteLength,
        pack: (packable) => Uint64LE.pack(BI.from(-1).add(packable)),
        unpack: (unpackable) => Uint64LE.unpack(unpackable).add(1),
    },
);

export type PackableOrderArgs = {
    revision: number,         // 1 byte
    terminalLock: {
        codeHash: HexString, // 32 bytes
        hashType: HashType,  // 1 byte
        args: HexString      // ?? bytes
    }
    sudtHash: HexString,     // 32 bytes
    isSudtToCkb: boolean,    // 1 byte
    ckbMultiplier: BI,       // 8 bytes
    sudtMultiplier: BI,      // 8 bytes
}

const newParametricOrderArgsCodec = (argsLength: number) => {
    const ParametricScriptCodec = struct(
        {
            codeHash: Byte32,
            hashType: HashTypeCodec,
            args: createFixedHexBytesCodec(argsLength),
        },
        ["codeHash", "hashType", "args"]
    );

    return struct(
        {
            revision: Uint8,
            terminalLock: ParametricScriptCodec,
            sudtHash: Byte32,
            isSudtToCkb: BooleanCodec,
            ckbMultiplier: PositiveUint64LE,
            sudtMultiplier: PositiveUint64LE,
        },
        ["revision", "terminalLock", "sudtHash", "isSudtToCkb", "ckbMultiplier", "sudtMultiplier"]
    );
}

export const errorInvalidOrderRevision = "This codec implements exclusively revision zero of limit order arg codec";
const size = 100;
const limitOrderArgsCodecs = Object.freeze(Array.from({ length: size }, (_, i) => newParametricOrderArgsCodec(i)));
export const LimitOrderArgsCodec = createBytesCodec<PackableOrderArgs>({
    pack: (packable) => {
        if (packable.revision !== 0) {
            throw Error(errorInvalidOrderRevision);
        }
        const n = (packable.terminalLock.args.length - 2) / 2;
        return (n < size ? limitOrderArgsCodecs[n] : newParametricOrderArgsCodec(n)).pack(packable);
    },
    unpack: (packed) => {
        if (packed[0] !== 0) {
            throw Error(errorInvalidOrderRevision);
        }
        const n = packed.length - limitOrderArgsCodecs[0].byteLength;
        return (n < size ? limitOrderArgsCodecs[n] : newParametricOrderArgsCodec(n)).unpack(packed);
    }
});