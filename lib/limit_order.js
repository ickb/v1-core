"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LimitOrderCodec = exports.newLimitOrderUtils = void 0;
const blockchain_1 = require("@ckb-lumos/base/lib/blockchain");
const codec_1 = require("@ckb-lumos/codec");
const bytes_1 = require("@ckb-lumos/codec/lib/bytes");
const molecule_1 = require("@ckb-lumos/codec/lib/molecule");
const number_1 = require("@ckb-lumos/codec/lib/number");
const bi_1 = require("@ckb-lumos/bi");
const helpers_1 = require("@ckb-lumos/helpers");
const lumos_utils_1 = require("lumos-utils");
const utils_1 = require("@ckb-lumos/base/lib/utils");
const domain_logic_1 = require("./domain_logic");
function newLimitOrderUtils(limitOrderLock = (0, lumos_utils_1.defaultScript)("LIMIT_ORDER"), sudtType = (0, domain_logic_1.ickbSudtType)()) {
    const sudtHash = (0, utils_1.computeScriptHash)(sudtType);
    function create(data) {
        let cell = {
            cellOutput: {
                capacity: "0x42",
                lock: { ...limitOrderLock, args: (0, bytes_1.hexify)(exports.LimitOrderCodec.pack(data)) },
                type: sudtType,
            },
            data: (0, bytes_1.hexify)(number_1.Uint128LE.pack((data.sudtAmount || 0)))
        };
        cell.cellOutput.capacity = (data.ckbAmount || (0, helpers_1.minimalCellCapacityCompatible)(cell, { validate: false })).toHexString();
        return cell;
    }
    function fulfill(order, ckbAllowance, sudtAllowance) {
        const data = extract(order);
        const cell = {
            cellOutput: { capacity: "0x42", lock: data.terminalLock, type: sudtType, },
            data: "0x00000000000000000000000000000000"
        };
        // Try to fulfill the order completely
        if (data.isSudtToCkb) {
            const outSudt = bi_1.BI.from(0);
            const outCkb = calculate(data.sudtMultiplier, data.ckbMultiplier, data.sudtAmount, data.ckbAmount, outSudt);
            cell.cellOutput.capacity = outCkb.toHexString();
            cell.cellOutput.type = undefined;
            cell.data = "0x";
            if (!ckbAllowance || outCkb.sub(data.ckbAmount).lte(ckbAllowance)) {
                return cell;
            }
        }
        else {
            const outCkb = (0, helpers_1.minimalCellCapacityCompatible)(cell, { validate: false });
            const outSudt = calculate(data.ckbMultiplier, data.sudtMultiplier, data.ckbAmount, data.sudtAmount, outCkb);
            cell.cellOutput.capacity = outCkb.toHexString();
            cell.data = (0, bytes_1.hexify)(number_1.Uint128LE.pack(outSudt));
            if (!sudtAllowance || outSudt.sub(data.sudtAmount).lte(sudtAllowance)) {
                return cell;
            }
        }
        // Allowance limits the order fulfillment, so the output cell is a still a limit order
        cell.cellOutput.lock = order.cellOutput.lock;
        let outCkb;
        let outSudt;
        if (data.isSudtToCkb) {
            // DoS prevention: 100 CKB is the minimum partial fulfillment.
            if (ckbAllowance.lt((0, bi_1.parseUnit)("100", "ckb"))) {
                throw Error("Not enough ckb allowance");
            }
            outCkb = data.ckbAmount.add(ckbAllowance);
            outSudt = calculate(data.ckbMultiplier, data.sudtMultiplier, data.ckbAmount, data.sudtAmount, outCkb);
        }
        else {
            // DOS prevention: the equivalent of 100 CKB is the minimum partial fulfillment.
            if (sudtAllowance.mul(data.sudtMultiplier).lt((0, bi_1.parseUnit)("100", "ckb").mul(data.ckbMultiplier))) {
                throw Error("Not enough sudt allowance");
            }
            outSudt = data.sudtAmount.add(sudtAllowance);
            outCkb = calculate(data.sudtMultiplier, data.ckbMultiplier, data.sudtAmount, data.ckbAmount, outSudt);
        }
        cell.cellOutput.capacity = outCkb.toHexString();
        cell.data = (0, bytes_1.hexify)(number_1.Uint128LE.pack(outSudt));
        return cell;
    }
    function cancel(order) {
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
    function extract(order) {
        const { lock, type, capacity } = order.cellOutput;
        //Validate limit order lock
        if (!(0, lumos_utils_1.scriptEq)(lock, { ...limitOrderLock, args: lock.args })) {
            throw Error("Not a limit order");
        }
        const data = exports.LimitOrderCodec.unpack(lock.args);
        //Validate sudt type
        if ((type && !(0, lumos_utils_1.scriptEq)(type, sudtType)) || data.sudtHash !== sudtHash) {
            throw Error("Invalid limit order type");
        }
        const ckbAmount = bi_1.BI.from(capacity);
        let sudtAmount = bi_1.BI.from(0);
        if (type) {
            sudtAmount = number_1.Uint128LE.unpack(order.data);
        }
        return { ...data, ckbAmount, sudtAmount };
    }
    return {
        create, fulfill, cancel, extract,
        limitOrderLock: { ...limitOrderLock },
        sudtType: { ...sudtType },
        sudtHash
    };
}
exports.newLimitOrderUtils = newLimitOrderUtils;
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
const BooleanCodec = (0, codec_1.createFixedBytesCodec)({
    byteLength: 1,
    pack: (packable) => new Uint8Array([packable ? 1 : 0]),
    unpack: (unpackable) => unpackable.at(0) === 0 ? false : true,
});
const PositiveUint64LE = (0, codec_1.createFixedBytesCodec)({
    byteLength: number_1.Uint64LE.byteLength,
    pack: (packable) => number_1.Uint64LE.pack(bi_1.BI.from(-1).add(packable)),
    unpack: (unpackable) => number_1.Uint64LE.unpack(unpackable).add(1),
});
const newParametricLimitOrderCodec = (argsLength) => {
    const ParametricScriptCodec = (0, molecule_1.struct)({
        codeHash: blockchain_1.Byte32,
        hashType: blockchain_1.HashType,
        args: (0, blockchain_1.createFixedHexBytesCodec)(argsLength),
    }, ["codeHash", "hashType", "args"]);
    return (0, molecule_1.struct)({
        terminalLock: ParametricScriptCodec,
        sudtHash: blockchain_1.Byte32,
        isSudtToCkb: BooleanCodec,
        ckbMultiplier: PositiveUint64LE,
        sudtMultiplier: PositiveUint64LE,
    }, ["terminalLock", "sudtHash", "isSudtToCkb", "ckbMultiplier", "sudtMultiplier"]);
};
const minLimitOrderLength = newParametricLimitOrderCodec(0).byteLength;
exports.LimitOrderCodec = (0, codec_1.createBytesCodec)({
    pack: (packable) => newParametricLimitOrderCodec((packable.terminalLock.args.length - 2) / 2).pack(packable),
    unpack: (packed) => newParametricLimitOrderCodec(packed.length - minLimitOrderLength).unpack(packed),
});
//# sourceMappingURL=limit_order.js.map