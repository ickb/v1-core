import { Byte32, HashType as HashTypeCodec, Script } from "@ckb-lumos/base/lib/blockchain";
import { BytesLike, PackParam, UnpackResult, createBytesCodec, createFixedBytesCodec } from "@ckb-lumos/codec";
import { bytify, concat, hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number";
import { BI } from "@ckb-lumos/bi";
import { minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import { Cell } from "@ckb-lumos/base";
import { ickbSudtScript } from "./utils";
import { defaultScript } from "lumos-utils";

// Limit order rule on non decreasing value:
// inCkb * ckbM + inIckb * ickbM <= outCkb * ckbM + outIckb * ickbM

export function terminalCellOf(data: UnpackedOrder, inCkb: BI, inIckb: BI) {
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
        data: data.isSudtToCkb ? "0x" : "0x00000000000000000000000000000000",
    }

    if (!data.isSudtToCkb) {
        const outCkb = minimalCellCapacityCompatible(cell);
        const outIckb = inCkb.mul(data.sudtMultiplier)
            .add(inCkb.sub(outCkb).mul(data.ckbMultiplier))
            .div(data.sudtMultiplier);
        cell.cellOutput.capacity = outCkb.toHexString();
        cell.data = hexify(Uint128LE.pack(outIckb))

        return { cell, outCkb, outIckb }
    } else {
        const outCkb = inCkb.mul(data.ckbMultiplier)
            .add(inIckb.mul(data.sudtMultiplier))
            .div(data.ckbMultiplier);
        const outIckb = BI.from(0);
        cell.cellOutput.capacity = outCkb.toHexString();

        return { cell, outCkb, outIckb }
    }
}

export async function createOrderCell(data: PackableOrder, amount: BI) {
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

export async function deleteOrderCell(orderCell: Cell) {
    const unpacked = LimitOrderCodec.unpack(orderCell.cellOutput.lock.args);

    return {
        cellOutput: {
            capacity: orderCell.cellOutput.capacity,
            lock: {
                codeHash: unpacked.codeHash,
                hashType: unpacked.hashType,
                args: unpacked.args
            },
            type: ickbSudtScript(),
        },
        data: orderCell.data
    };
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