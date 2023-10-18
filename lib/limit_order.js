"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LimitOrderCodec = exports.ArgsLimitOrderCodec = exports.PartialLimitOrderCodec = exports.BooleanCodec = exports.deleteOrderCell = exports.createOrderCell = exports.terminalCellOf = void 0;
const blockchain_1 = require("@ckb-lumos/base/lib/blockchain");
const codec_1 = require("@ckb-lumos/codec");
const bytes_1 = require("@ckb-lumos/codec/lib/bytes");
const molecule_1 = require("@ckb-lumos/codec/lib/molecule");
const number_1 = require("@ckb-lumos/codec/lib/number");
const bi_1 = require("@ckb-lumos/bi");
const helpers_1 = require("@ckb-lumos/helpers");
const utils_1 = require("./utils");
const lumos_utils_1 = require("lumos-utils");
// Limit order rule on non decreasing value:
// inCkb * ckbM + inIckb * ickbM <= outCkb * ckbM + outIckb * ickbM
function terminalCellOf(data, inCkb, inIckb) {
    let cell = {
        cellOutput: {
            capacity: "0x",
            lock: {
                codeHash: data.codeHash,
                hashType: data.hashType,
                args: data.args,
            },
            type: data.isSudtToCkb ? undefined : (0, utils_1.ickbSudtScript)(),
        },
        data: data.isSudtToCkb ? "0x" : "0x00000000000000000000000000000000",
    };
    if (!data.isSudtToCkb) {
        const outCkb = (0, helpers_1.minimalCellCapacityCompatible)(cell);
        const outIckb = inCkb.mul(data.sudtMultiplier)
            .add(inCkb.sub(outCkb).mul(data.ckbMultiplier))
            .div(data.sudtMultiplier);
        cell.cellOutput.capacity = outCkb.toHexString();
        cell.data = (0, bytes_1.hexify)(number_1.Uint128LE.pack(outIckb));
        return { cell, outCkb, outIckb };
    }
    else {
        const outCkb = inCkb.mul(data.ckbMultiplier)
            .add(inIckb.mul(data.sudtMultiplier))
            .div(data.ckbMultiplier);
        const outIckb = bi_1.BI.from(0);
        cell.cellOutput.capacity = outCkb.toHexString();
        return { cell, outCkb, outIckb };
    }
}
exports.terminalCellOf = terminalCellOf;
async function createOrderCell(data, amount) {
    let cell = {
        cellOutput: {
            capacity: "0x",
            lock: {
                ...(0, lumos_utils_1.defaultScript)("LIMIT_ORDER"),
                args: (0, bytes_1.hexify)(exports.LimitOrderCodec.pack(data)),
            },
            type: (0, utils_1.ickbSudtScript)(),
        },
        data: (0, bytes_1.hexify)(number_1.Uint128LE.pack((data.isSudtToCkb ? amount : 0)))
    };
    cell.cellOutput.capacity = (data.isSudtToCkb ? (0, helpers_1.minimalCellCapacityCompatible)(cell) : amount).toHexString();
    return cell;
}
exports.createOrderCell = createOrderCell;
async function deleteOrderCell(orderCell) {
    const unpacked = exports.LimitOrderCodec.unpack(orderCell.cellOutput.lock.args);
    return {
        cellOutput: {
            capacity: orderCell.cellOutput.capacity,
            lock: {
                codeHash: unpacked.codeHash,
                hashType: unpacked.hashType,
                args: unpacked.args
            },
            type: (0, utils_1.ickbSudtScript)(),
        },
        data: orderCell.data
    };
}
exports.deleteOrderCell = deleteOrderCell;
// Limit Order codec, hacked together based on @homura's LimitOrderCodec implementation:
// https://github.com/ckb-js/lumos/issues/539#issuecomment-1646452128
exports.BooleanCodec = (0, codec_1.createFixedBytesCodec)({
    byteLength: 1,
    pack: (packable) => new Uint8Array([packable ? 1 : 0]),
    unpack: (unpackable) => unpackable.at(0) === 0 ? false : true,
});
exports.PartialLimitOrderCodec = (0, molecule_1.struct)({
    sudtHash: blockchain_1.Byte32,
    isSudtToCkb: exports.BooleanCodec,
    sudtMultiplier: number_1.Uint64LE,
    ckbMultiplier: number_1.Uint64LE,
    codeHash: blockchain_1.Byte32,
    hashType: blockchain_1.HashType,
}, ["sudtHash", "isSudtToCkb", "sudtMultiplier", "ckbMultiplier", "codeHash", "hashType"]);
exports.ArgsLimitOrderCodec = (0, codec_1.createBytesCodec)({
    pack: (unpacked) => (0, bytes_1.bytify)(unpacked.args),
    unpack: (packed) => ({ args: (0, bytes_1.hexify)(packed) }),
});
exports.LimitOrderCodec = (0, codec_1.createBytesCodec)({
    pack: (unpacked) => {
        return (0, bytes_1.concat)(exports.PartialLimitOrderCodec.pack(unpacked), exports.ArgsLimitOrderCodec.pack(unpacked));
    },
    unpack: (packed) => {
        const packedConfig = packed.slice(0, exports.PartialLimitOrderCodec.byteLength);
        const packedArgs = packed.slice(exports.PartialLimitOrderCodec.byteLength);
        const config = exports.PartialLimitOrderCodec.unpack(packedConfig);
        const args = exports.ArgsLimitOrderCodec.unpack(packedArgs);
        return { ...config, ...args };
    },
});
//# sourceMappingURL=limit_order.js.map