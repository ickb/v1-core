import { Byte32, HashType as HashTypeCodec } from "@ckb-lumos/base/lib/blockchain";
import { BytesLike, PackParam, UnpackResult, createBytesCodec, createFixedBytesCodec } from "@ckb-lumos/codec";
import { bytify, concat, hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi";
import { minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import { Cell, Script } from "@ckb-lumos/base";
import { defaultScript, scriptEq } from "lumos-utils";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { ickbSudtScript } from "./domain_logic";

export function newLimitOrderUtils(sudtType: Script = ickbSudtScript()) {
    const sudtHash = computeScriptHash(sudtType);

    function create(data: PackableOrder & { ckbAmount?: BI, sudtAmount?: BI }) {
        let cell = {
            cellOutput: {
                capacity: "0x42",
                lock: { ...defaultScript("LIMIT_ORDER"), args: hexify(LimitOrderCodec.pack(data)) },
                type: sudtType,
            },
            data: hexify(Uint128LE.pack((data.sudtAmount || 0)))
        }
        cell.cellOutput.capacity = (data.ckbAmount || minimalCellCapacityCompatible(cell)).toHexString();

        return cell;
    }

    function fulfill(order: Cell, ckbAllowance: BI | undefined, sudtAllowance: BI | undefined) {
        const data = extract(order);

        const cell: Cell = {
            cellOutput: { capacity: "0x42", lock: data.terminalLock, type: sudtType, },
            data: "0x00000000000000000000000000000000"
        }

        // Try to fulfill the order completely
        if (data.isSudtToCkb) {
            const outSudt = BI.from(0);
            const outCkb = calculate(data.sudtMultiplier, data.ckbMultiplier, data.sudtAmount, data.ckbAmount, outSudt);
            cell.cellOutput.capacity = outCkb.toHexString();
            cell.cellOutput.type = undefined;
            cell.data = "0x";
            if (!ckbAllowance || outCkb.sub(data.ckbAmount).lte(ckbAllowance)) {
                return cell;
            }
        } else {
            const outCkb = minimalCellCapacityCompatible(cell);
            const outSudt = calculate(data.ckbMultiplier, data.sudtMultiplier, data.ckbAmount, data.sudtAmount, outCkb);
            cell.cellOutput.capacity = outCkb.toHexString();
            cell.data = hexify(Uint128LE.pack(outSudt));
            if (!sudtAllowance || outSudt.sub(data.sudtAmount).lte(sudtAllowance)) {
                return cell;
            }
        }

        // Allowance limits the order fulfillment, so the output cell is a still a limit order
        cell.cellOutput.lock = order.cellOutput.lock;
        let outCkb: BI;
        let outSudt: BI;
        if (data.isSudtToCkb) {
            // DoS prevention: 100 CKB is the minimum partial fulfillment.
            if (ckbAllowance!.lt(parseUnit("100", "ckb"))) {
                throw Error("Not enough ckb allowance");
            }
            outCkb = data.ckbAmount.add(ckbAllowance!)
            outSudt = calculate(data.ckbMultiplier, data.sudtMultiplier, data.ckbAmount, data.sudtAmount, outCkb);
        } else {
            // DOS prevention: the equivalent of 100 CKB is the minimum partial fulfillment.
            if (sudtAllowance!.mul(data.sudtMultiplier).lt(parseUnit("100", "ckb").mul(data.ckbMultiplier))) {
                throw Error("Not enough sudt allowance");
            }
            outSudt = data.sudtAmount.add(sudtAllowance!);
            outCkb = calculate(data.sudtMultiplier, data.ckbMultiplier, data.sudtAmount, data.ckbAmount, outSudt);
        }
        cell.cellOutput.capacity = outCkb.toHexString();
        cell.data = hexify(Uint128LE.pack(outSudt));

        return cell;
    }

    function cancel(order: Cell) {
        const data = extract(order);
        return {
            cellOutput: {
                capacity: order.cellOutput.capacity,
                lock: data.terminalLock,
                type: order.cellOutput.type,
            },
            data: order.data
        };
    }

    function extract(order: Cell) {
        const data = LimitOrderCodec.unpack(order.cellOutput.lock.args);

        //Validate sudt type
        const type = order.cellOutput.type;
        if ((type && !scriptEq(type, sudtType)) || data.sudtHash !== sudtHash) {
            throw Error("Invalid limit order type");
        }

        const ckbAmount = BI.from(order.cellOutput.capacity);
        let sudtAmount = BI.from(0);
        if (type) {
            sudtAmount = Uint128LE.unpack(order.data);
        }

        const terminalLock: Script = {
            codeHash: data.codeHash,
            hashType: data.hashType,
            args: data.args
        }

        return { ...data, ckbAmount, sudtAmount, terminalLock }
    }

    return { create, fulfill, cancel }
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

// Limit Order codec, hacked together based on @homura's LimitOrderCodec implementation:
// https://github.com/ckb-js/lumos/issues/539#issuecomment-1646452128

export const BooleanCodec = createFixedBytesCodec<boolean>(
    {
        byteLength: 1,
        pack: (packable) => new Uint8Array([packable ? 1 : 0]),
        unpack: (unpackable) => unpackable.at(0)! === 0 ? false : true,
    },
);

export const PositiveUint64LE = createFixedBytesCodec<BI, BIish>(
    {
        byteLength: Uint64LE.byteLength,
        pack: (packable) => Uint64LE.pack(BI.from(-1).add(packable)),
        unpack: (unpackable) => Uint64LE.unpack(unpackable).add(1),
    },
);

export const PartialLimitOrderCodec = struct(
    {
        sudtHash: Byte32,
        isSudtToCkb: BooleanCodec,
        sudtMultiplier: PositiveUint64LE,
        ckbMultiplier: PositiveUint64LE,
        codeHash: Byte32,
        hashType: HashTypeCodec,
    },
    ["sudtHash", "isSudtToCkb", "sudtMultiplier", "ckbMultiplier", "codeHash", "hashType"]
);

export const ArgsLimitOrderCodec = createBytesCodec<{ args: string }, { args: BytesLike }>({
    pack: (unpacked) => bytify(unpacked.args),
    unpack: (packed) => ({ args: hexify(packed) }),
});

export type PackableOrder = PackParam<typeof PartialLimitOrderCodec> & PackParam<typeof ArgsLimitOrderCodec>;
export type UnpackedOrder = UnpackResult<typeof PartialLimitOrderCodec> & UnpackResult<typeof ArgsLimitOrderCodec>;

export const LimitOrderCodec = createBytesCodec<UnpackedOrder, PackableOrder>({
    pack: (unpacked) => {
        return concat(PartialLimitOrderCodec.pack(unpacked), ArgsLimitOrderCodec.pack(unpacked));
    },
    unpack: (packed): UnpackedOrder => {
        const packedConfig = packed.slice(0, PartialLimitOrderCodec.byteLength)
        const packedArgs = packed.slice(PartialLimitOrderCodec.byteLength)

        const config = PartialLimitOrderCodec.unpack(packedConfig);
        const args = ArgsLimitOrderCodec.unpack(packedArgs);

        return { ...config, ...args };
    },
});