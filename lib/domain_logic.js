"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ckbSoftCapPerDeposit = exports.receiptIckbEquivalentValue = exports.ickbEquivalentValue = exports.ICKB_SOFT_CAP_PER_DEPOSIT = exports.AR_0 = exports.ReceiptCodec = exports.ickbSudtType = exports.IckbTransactionBuilder = void 0;
const utils_1 = require("@ckb-lumos/base/lib/utils");
const bi_1 = require("@ckb-lumos/bi");
const bytes_1 = require("@ckb-lumos/codec/lib/bytes");
const molecule_1 = require("@ckb-lumos/codec/lib/molecule");
const number_1 = require("@ckb-lumos/codec/lib/number");
const dao_1 = require("@ckb-lumos/common-scripts/lib/dao");
const helpers_1 = require("@ckb-lumos/helpers");
const lumos_utils_1 = require("lumos-utils");
class IckbTransactionBuilder extends lumos_utils_1.TransactionBuilder {
    async toChange(ckbDelta, changeCells = []) {
        function changeCellsPush(c) {
            const minimalCapacity = (0, helpers_1.minimalCellCapacityCompatible)(c, { validate: false });
            if (ckbDelta.lt(minimalCapacity)) {
                throw Error("Missing CKB: not enough funds to execute the transaction");
            }
            c.cellOutput.capacity = minimalCapacity.toHexString();
            changeCells.push(c);
            ckbDelta = ckbDelta.sub(minimalCapacity);
        }
        const ickbDeposits = [];
        const ownedCells = [];
        for (const cell of this.outputs.filter((cell) => (0, lumos_utils_1.scriptEq)(cell.cellOutput.lock, (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC")))) {
            if ((0, lumos_utils_1.isDAODeposit)(cell)) {
                ickbDeposits.push(cell);
            }
            else {
                ownedCells.push(cell);
            }
        }
        //Maybe add an Owner Lock cell to enable later conversion from Receipt to iCKB
        if (ickbDeposits.length > 0 && ownedCells.length == 0) {
            const ownerLockCell = {
                cellOutput: {
                    capacity: "0x42",
                    lock: (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"),
                    type: undefined
                },
                data: "0x"
            };
            changeCellsPush(ownerLockCell);
            ownedCells.push(ownerLockCell);
        }
        //Maybe add iCKB receipt cell
        if (ownedCells.length > 0) {
            const receipt = {
                cellOutput: {
                    capacity: "0x42",
                    lock: this.getAccountLock(),
                    type: (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC")
                },
                data: (0, bytes_1.hexify)(exports.ReceiptCodec.pack({
                    ownedQuantity: ownedCells.length,
                    depositQuantity: ickbDeposits.length,
                    depositAmount: ickbDeposits.length > 0 ?
                        bi_1.BI.from(ickbDeposits[0].cellOutput.capacity)
                            .sub((0, helpers_1.minimalCellCapacityCompatible)(ickbDeposits[0]))
                        : bi_1.BI.from(0)
                }))
            };
            changeCellsPush(receipt);
        }
        //Add iCKB SUDT change cell
        const ickbDelta = await this.getIckbDelta(this.inputs, [...this.outputs, ...changeCells]);
        if (ickbDelta.lt(0)) {
            throw Error("Missing iCKB SUDT: not enough funds to execute the transaction");
        }
        else if (ickbDelta.eq(0)) {
            //Do nothing
        }
        else {
            const sudtChangeCell = {
                cellOutput: {
                    capacity: "0x42",
                    lock: this.accountLock,
                    type: ickbSudtType()
                },
                data: (0, bytes_1.hexify)(number_1.Uint128LE.pack(ickbDelta))
            };
            changeCellsPush(sudtChangeCell);
        }
        return super.toChange(ckbDelta, changeCells);
    }
    async getIckbDelta(inputs = this.inputs, outputs = this.outputs) {
        let ickbDelta = bi_1.BI.from(0);
        for (const c of inputs) {
            //iCKB token
            if ((0, lumos_utils_1.scriptEq)(c.cellOutput.type, ickbSudtType())) {
                ickbDelta = ickbDelta.add(number_1.Uint128LE.unpack(c.data));
                continue;
            }
            //Withdrawal from iCKB pool of NervosDAO deposits
            if ((0, lumos_utils_1.scriptEq)(c.cellOutput.lock, (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC")) && (0, lumos_utils_1.isDAODeposit)(c)) {
                const header = await this.getHeaderByNumber(c.blockNumber);
                const ckbUnoccupiedCapacity = bi_1.BI.from(c.cellOutput.capacity).sub((0, helpers_1.minimalCellCapacityCompatible)(c, { validate: false }));
                ickbDelta = ickbDelta.sub(ickbEquivalentValue(ckbUnoccupiedCapacity, header));
                continue;
            }
            //iCKB Receipt
            if ((0, lumos_utils_1.scriptEq)(c.cellOutput.type, (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"))) {
                const header = await this.getHeaderByNumber(c.blockNumber);
                const { depositQuantity, depositAmount } = exports.ReceiptCodec.unpack(c.data);
                ickbDelta = ickbDelta.add(receiptIckbEquivalentValue(depositQuantity, depositAmount, header));
            }
        }
        for (const c of outputs) {
            //iCKB token
            if ((0, lumos_utils_1.scriptEq)(c.cellOutput.type, ickbSudtType())) {
                ickbDelta = ickbDelta.sub(number_1.Uint128LE.unpack(c.data));
            }
        }
        return ickbDelta;
    }
    async getHeaderDepsBlockNumbers(transaction) {
        const blockNumbers = await super.getHeaderDepsBlockNumbers(transaction);
        for (const c of transaction.inputs) {
            if (!c.blockNumber) {
                throw Error("Cell must have blockNumber populated");
            }
            if ((0, lumos_utils_1.scriptEq)(c.cellOutput.type, (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"))) {
                blockNumbers.push(c.blockNumber);
            }
        }
        return blockNumbers;
    }
}
exports.IckbTransactionBuilder = IckbTransactionBuilder;
function ickbSudtType() {
    return {
        ...(0, lumos_utils_1.defaultScript)("SUDT"),
        args: (0, utils_1.computeScriptHash)((0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"))
    };
}
exports.ickbSudtType = ickbSudtType;
exports.ReceiptCodec = (0, molecule_1.struct)({
    ownedQuantity: number_1.Uint8,
    depositQuantity: number_1.Uint8,
    depositAmount: (0, lumos_utils_1.createUintBICodec)(6, true),
}, ["ownedQuantity", "depositQuantity", "depositAmount"]);
exports.AR_0 = bi_1.BI.from("10000000000000000");
exports.ICKB_SOFT_CAP_PER_DEPOSIT = (0, bi_1.parseUnit)("100000", "ckb");
function ickbEquivalentValue(ckbUnoccupiedCapacity, header) {
    const daoData = (0, dao_1.extractDaoDataCompatible)(header.dao);
    const AR_m = daoData["ar"];
    let ickbAmount = ckbUnoccupiedCapacity.mul(exports.AR_0).div(AR_m);
    if (exports.ICKB_SOFT_CAP_PER_DEPOSIT.lt(ickbAmount)) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickbAmount = ickbAmount.sub(ickbAmount.sub(exports.ICKB_SOFT_CAP_PER_DEPOSIT).div(10));
    }
    return ickbAmount;
}
exports.ickbEquivalentValue = ickbEquivalentValue;
function receiptIckbEquivalentValue(receiptCount, receiptAmount, header) {
    return ickbEquivalentValue(receiptAmount, header).mul(receiptCount);
}
exports.receiptIckbEquivalentValue = receiptIckbEquivalentValue;
function ckbSoftCapPerDeposit(header) {
    const daoData = (0, dao_1.extractDaoDataCompatible)(header.dao);
    const AR_m = daoData["ar"];
    return exports.ICKB_SOFT_CAP_PER_DEPOSIT.mul(AR_m).div(exports.AR_0).add(1);
}
exports.ckbSoftCapPerDeposit = ckbSoftCapPerDeposit;
//# sourceMappingURL=domain_logic.js.map