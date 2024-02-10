import { Byte32, HashType as HashTypeCodec, createFixedHexBytesCodec } from "@ckb-lumos/base/lib/blockchain";
import { createBytesCodec, createFixedBytesCodec } from "@ckb-lumos/codec";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi";
import { TransactionSkeletonType } from "@ckb-lumos/helpers";
import { Cell, HashType, HexString } from "@ckb-lumos/base";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import {
    BooleanCodec, I8Cell, I8Script, addCells, capacitiesSifter,
    defaultScript, i8ScriptPadding, scriptEq, sudtSifter
} from "@ickb/lumos-utils";
import { ickbSudtType } from "./ickb_logic";

export function limitOrder(sudtType: I8Script = i8ScriptPadding) {
    if (sudtType == i8ScriptPadding) {
        sudtType = ickbSudtType();
    }
    const orderLock = limitOrderLock();
    const sudtHash = computeScriptHash(sudtType);

    function create(tx: TransactionSkeletonType, data: PackableOrder & { ckbAmount?: BI, sudtAmount?: BI }) {
        const c = I8Cell.from({
            lock: I8Script.from({ ...orderLock, args: hexify(LimitOrderCodec.pack(data)) }),
            type: sudtType,
            capacity: (data.ckbAmount ?? BI.from(0)).toHexString(),
            data: hexify(Uint128LE.pack((data.sudtAmount ?? 0)))
        });

        return addCells(tx, "append", [], [c]);
    }

    function fulfill(
        tx: TransactionSkeletonType,
        order: I8Cell,
        ckbAllowance: BI | undefined,
        sudtAllowance: BI | undefined
    ) {
        const o = extract(order);

        let cell = I8Cell.from({
            lock: o.terminalLock,
            type: sudtType,
            data: "0x00000000000000000000000000000000",
        });

        // Try to fulfill the order completely
        if (o.isSudtToCkb) {
            const outSudt = BI.from(0);
            const outCkb = calculate(o.sudtMultiplier, o.ckbMultiplier, o.sudtAmount, o.ckbAmount, outSudt);

            cell = I8Cell.from({
                ...cell,
                capacity: outCkb.toHexString(),
                type: undefined,
                data: "0x"
            });
            if (!ckbAllowance || outCkb.sub(o.ckbAmount).lte(ckbAllowance)) {
                return addCells(tx, "matched", [order], [cell]);
            }
        } else {
            const outCkb = BI.from(cell.cellOutput.capacity);
            const outSudt = calculate(o.ckbMultiplier, o.sudtMultiplier, o.ckbAmount, o.sudtAmount, outCkb);

            cell = I8Cell.from({
                ...cell,
                data: hexify(Uint128LE.pack(outSudt))
            });
            if (!sudtAllowance || outSudt.sub(o.sudtAmount).lte(sudtAllowance)) {
                return addCells(tx, "matched", [order], [cell]);
            }
        }

        // Allowance limits the order fulfillment, so the output cell is a still a limit order
        let outCkb: BI;
        let outSudt: BI;
        if (o.isSudtToCkb) {
            // DoS prevention: 100 CKB is the minimum partial fulfillment.
            if (ckbAllowance!.lt(parseUnit("100", "ckb"))) {
                throw Error("Not enough ckb allowance");
            }
            outCkb = o.ckbAmount.add(ckbAllowance!)
            outSudt = calculate(o.ckbMultiplier, o.sudtMultiplier, o.ckbAmount, o.sudtAmount, outCkb);
        } else {
            // DOS prevention: the SUDT equivalent of 100 CKB is the minimum partial fulfillment.
            if (sudtAllowance!.mul(o.sudtMultiplier).lt(parseUnit("100", "ckb").mul(o.ckbMultiplier))) {
                throw Error("Not enough sudt allowance");
            }
            outSudt = o.sudtAmount.add(sudtAllowance!);
            outCkb = calculate(o.sudtMultiplier, o.ckbMultiplier, o.sudtAmount, o.ckbAmount, outSudt);
        }

        cell = I8Cell.from({
            lock: order.cellOutput.lock,
            capacity: outCkb.toHexString(),
            data: hexify(Uint128LE.pack(outSudt))
        });
        return addCells(tx, "matched", [order], [cell]);
    }

    function cancel(tx: TransactionSkeletonType, order: I8Cell) {
        const data = extract(order);
        const c = I8Cell.from({ ...order, lock: data.terminalLock });
        return addCells(tx, "matched", [order], [c]);
    }

    function expander(order: Cell) {
        const { lock, type } = order.cellOutput;
        const i8lock = I8Script.from({ ...orderLock, args: lock.args });

        //Validate limit order lock
        if (!scriptEq(lock, i8lock)) {
            return undefined;
        }

        //Validate sudt type
        const o = LimitOrderCodec.unpack(lock.args);
        if ((type && !scriptEq(type, sudtType)) || o.sudtHash !== sudtHash) {
            return undefined;
        }

        return i8lock;
    }

    function sifter(inputs: readonly Cell[]) {
        let { owned, unknowns } = capacitiesSifter(inputs, expander);
        let ownedTmp = owned;
        ({ owned, unknowns } = sudtSifter(unknowns, sudtType, expander));
        owned = [...ownedTmp, ...owned];

        return { owned, unknowns };
    }

    function extract(order: I8Cell) {
        const { lock, type, capacity } = order.cellOutput;

        //Validation is already done in expander and sifter
        const o = LimitOrderCodec.unpack(lock.args);
        return {
            ...o,
            terminalLock: I8Script.from({ ...i8ScriptPadding, ...o.terminalLock }),
            sudtAmount: type ? Uint128LE.unpack(order.data) : BI.from(0),
            ckbAmount: BI.from(capacity)
        };
    }

    function isValid(order: Cell) {
        return !!expander(order);
    }

    return {
        create, fulfill, cancel, extract, expander, sifter, isValid,
        limitOrderLock: orderLock,
        sudtType,
        sudtHash
    }
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

export type PackableOrder = {
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

const newParametricLimitOrderCodec = (argsLength: number) => {
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
            terminalLock: ParametricScriptCodec,
            sudtHash: Byte32,
            isSudtToCkb: BooleanCodec,
            ckbMultiplier: PositiveUint64LE,
            sudtMultiplier: PositiveUint64LE,
        },
        ["terminalLock", "sudtHash", "isSudtToCkb", "ckbMultiplier", "sudtMultiplier"]
    );
}

const size = 100;
const limitOrderCodecs = Object.freeze(Array.from({ length: size }, (_, i) => newParametricLimitOrderCodec(i)));
export const LimitOrderCodec = createBytesCodec<PackableOrder>({
    pack: (packable) => {
        const n = (packable.terminalLock.args.length - 2) / 2;
        return (n < size ? limitOrderCodecs[n] : newParametricLimitOrderCodec(n)).pack(packable);
    },
    unpack: (packed) => {
        const n = packed.length - limitOrderCodecs[0].byteLength;
        return (n < size ? limitOrderCodecs[n] : newParametricLimitOrderCodec(n)).unpack(packed);
    }
});