"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LimitOrderCodec = exports.ArgsLimitOrderCodec = exports.PartialLimitOrderCodec = exports.BooleanCodec = exports.fulfill = exports.cancel = exports.create = void 0;
const blockchain_1 = require("@ckb-lumos/base/lib/blockchain");
const codec_1 = require("@ckb-lumos/codec");
const bytes_1 = require("@ckb-lumos/codec/lib/bytes");
const molecule_1 = require("@ckb-lumos/codec/lib/molecule");
const number_1 = require("@ckb-lumos/codec/lib/number");
const bi_1 = require("@ckb-lumos/bi");
const helpers_1 = require("@ckb-lumos/helpers");
const utils_1 = require("./utils");
const lumos_utils_1 = require("lumos-utils");
function create(data, amount) {
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
exports.create = create;
function cancel(order) {
    const unpacked = exports.LimitOrderCodec.unpack(order.cellOutput.lock.args);
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
exports.cancel = cancel;
// Limit order rule on non decreasing value:
// min bOut such that aM * aIn + bM * bIn <= aM * aOut + bM * bOut
// bOut = (aM * (aIn - aOut) + bM * bIn) / bM
// But integer divisions truncate, so we need to round to the upper value
// bOut = (aM * (aIn - aOut) + bM * bIn + bM - 1) / bM
// bOut = (aM * (aIn - aOut) + bM * (bIn + 1) - 1) / bM
function calculate(aM, bM, aIn, bIn, aOut) {
    return aM.mul(aIn.sub(aOut))
        .add(bM.mul(bIn.add(1)).sub(1))
        .div(bM);
}
function fulfill(order) {
    const data = exports.LimitOrderCodec.unpack(order.cellOutput.lock.args);
    const inCkb = bi_1.BI.from(order.cellOutput.capacity);
    let inIckb = bi_1.BI.from(0);
    if (order.cellOutput.type === undefined) {
        //Do nothing
    }
    else if (order.cellOutput.type === (0, utils_1.ickbSudtScript)()) {
        inIckb = number_1.Uint128LE.unpack(order.data);
    }
    else {
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
            type: data.isSudtToCkb ? undefined : (0, utils_1.ickbSudtScript)(),
        },
        data: "0x"
    };
    // Limit order rule on non decreasing value:
    // inCkb * ckbM + inIckb * ickbM <= outCkb * ckbM + outIckb * ickbM
    if (data.isSudtToCkb) {
        const outIckb = bi_1.BI.from(0);
        const outCkb = calculate(data.sudtMultiplier, data.ckbMultiplier, inIckb, inCkb, outIckb);
        cell.cellOutput.capacity = outCkb.toHexString();
    }
    else {
        const outCkb = (0, helpers_1.minimalCellCapacityCompatible)(cell);
        const outIckb = calculate(data.ckbMultiplier, data.sudtMultiplier, inCkb, inIckb, outCkb);
        cell.cellOutput.capacity = outCkb.toHexString();
        cell.data = (0, bytes_1.hexify)(number_1.Uint128LE.pack(outIckb));
    }
    return cell;
}
exports.fulfill = fulfill;
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