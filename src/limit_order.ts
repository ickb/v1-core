import { Byte32, HashType as HashTypeCodec } from "@ckb-lumos/base/lib/blockchain";
import { BytesLike, PackParam, UnpackResult, createBytesCodec, createFixedBytesCodec } from "@ckb-lumos/codec";
import { bytify, concat, hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number";
import { BI } from "@ckb-lumos/bi";
import { minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import { Cell } from "@ckb-lumos/base";
import { ickbSudtScript } from "./utils";
import { defaultScript } from "lumos-utils";

export function create(data: PackableOrder, amount: BI) {
    let cell = {
        cellOutput: {
            capacity: "0x",
            lock: {
                ...defaultScript("LIMIT_ORDER"),
                args: hexify(LimitOrderCodec.pack(data)),
            },
            type: ickbSudtScript(),
        },
        data: hexify(Uint128LE.pack((data.isSudtToCkb ? amount : 0)))
    }
    cell.cellOutput.capacity = (data.isSudtToCkb ? minimalCellCapacityCompatible(cell) : amount).toHexString();

    return cell;
}

export function cancel(order: Cell) {
    const unpacked = LimitOrderCodec.unpack(order.cellOutput.lock.args);

    return {
        cellOutput: {
            capacity: order.cellOutput.capacity,
            lock: {
                codeHash: unpacked.codeHash,
                hashType: unpacked.hashType,
                args: unpacked.args
            },
            type: order.cellOutput.type,
        },
        data: order.data
    };
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

export function fulfill(order: Cell) {
    const data = LimitOrderCodec.unpack(order.cellOutput.lock.args);
    const inCkb = BI.from(order.cellOutput.capacity);
    let inIckb = BI.from(0);
    if (order.cellOutput.type === undefined) {
        //Do nothing
    } else if (order.cellOutput.type === ickbSudtScript()) {
        inIckb = Uint128LE.unpack(order.data);
    } else {
        throw Error("Limit order cell type not valid");
    }

    let cell = {
        cellOutput: {
            capacity: "0x",
            lock: {
                codeHash: data.codeHash,
                hashType: data.hashType,
                args: data.args,
            },
            type: data.isSudtToCkb ? undefined : ickbSudtScript(),
        },
        data: "0x"
    }

    // Limit order rule on non decreasing value:
    // inCkb * ckbM + inIckb * ickbM <= outCkb * ckbM + outIckb * ickbM
    if (data.isSudtToCkb) {
        const outIckb = BI.from(0);
        const outCkb = calculate(data.sudtMultiplier, data.ckbMultiplier, inIckb, inCkb, outIckb);
        cell.cellOutput.capacity = outCkb.toHexString();
    } else {
        const outCkb = minimalCellCapacityCompatible(cell);
        const outIckb = calculate(data.ckbMultiplier, data.sudtMultiplier, inCkb, inIckb, outCkb);
        cell.cellOutput.capacity = outCkb.toHexString();
        cell.data = hexify(Uint128LE.pack(outIckb));
    }

    return cell;
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

export const PartialLimitOrderCodec = struct(
    {
        sudtHash: Byte32,
        isSudtToCkb: BooleanCodec,
        sudtMultiplier: Uint64LE,
        ckbMultiplier: Uint64LE,
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