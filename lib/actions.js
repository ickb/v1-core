"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fund = exports.withdrawFrom = exports.deposit = void 0;
const lumos_utils_1 = require("lumos-utils");
const domain_logic_1 = require("./domain_logic");
const ckb_indexer_1 = require("@ckb-lumos/ckb-indexer");
const bi_1 = require("@ckb-lumos/bi");
const bytes_1 = require("@ckb-lumos/codec/lib/bytes");
const number_1 = require("@ckb-lumos/codec/lib/number");
function deposit(transactionBuilder, depositQuantity, depositAmount) {
    if (depositQuantity > 61) {
        throw Error(`depositQuantity is ${depositQuantity}, but should be less than 62`);
    }
    // Create depositQuantity deposits of occupied capacity + depositAmount.
    const deposit = {
        cellOutput: {
            capacity: (0, bi_1.parseUnit)("82", "ckb").add(depositAmount).toHexString(),
            lock: (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"),
            type: (0, lumos_utils_1.defaultScript)("DAO"),
        },
        data: lumos_utils_1.DAO_DEPOSIT_DATA
    };
    //transactionBuilder.toChange() will take care of adding the receipt and owner lock
    return transactionBuilder.add("output", "end", ...Array.from({ length: depositQuantity }, () => deposit));
}
exports.deposit = deposit;
function withdrawFrom(transactionBuilder, ...deposits) {
    const withdrawals = [];
    for (const deposit of deposits) {
        const withdrawal = {
            cellOutput: deposit.cellOutput,
            data: (0, bytes_1.hexify)(number_1.Uint64LE.pack(bi_1.BI.from(deposit.blockNumber)))
        };
        withdrawals.push(withdrawal);
    }
    //transactionBuilder.toChange() will take care of adding the receipt
    return transactionBuilder.add("input", "start", ...deposits)
        .add("output", "start", ...withdrawals);
}
exports.withdrawFrom = withdrawFrom;
async function fund(transactionBuilder) {
    const is_well_funded = async function () {
        try {
            await transactionBuilder.toTransactionSkeleton();
            return true;
        }
        catch (e) {
            //Improve error typing or define this function on builder itself/////////////////////////////////////////
            if (e.message === "Missing CKB: not enough funds to execute the transaction") {
                return false;
            }
            if (e.message === "Missing iCKB SUDT: not enough funds to execute the transaction") {
                return false;
            }
            throw e;
        }
    };
    if (await is_well_funded()) {
        return transactionBuilder;
    }
    const indexer = await (0, lumos_utils_1.getSyncedIndexer)();
    //Try adding receipts and see if it helps
    const tipEpoch = (0, lumos_utils_1.parseEpoch)((await (0, lumos_utils_1.getRpc)().getTipHeader()).epoch); //Maybe pass as parameter to the fund function///
    for await (const receiptCell of new ckb_indexer_1.CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        type: (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"),
        lock: transactionBuilder.getAccountLock()
    }).collect()) {
        const { ownedQuantity } = domain_logic_1.ReceiptCodec.unpack(receiptCell.data);
        //Add owned cells referenced in the receipt
        let ownedCells = [];
        for await (const ownedCell of new ckb_indexer_1.CellCollector(indexer, {
            scriptSearchMode: "exact",
            withData: true,
            lock: (0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"),
            fromBlock: receiptCell.blockNumber,
            toBlock: receiptCell.blockNumber,
        }).collect()) {
            //Add only cells in this receipt
            if (ownedCell.outPoint.txHash != receiptCell.outPoint.txHash) {
                continue;
            }
            //Deposit cells are not part of the owned cells
            if ((0, lumos_utils_1.isDAODeposit)(ownedCell)) {
                continue;
            }
            //For now only Owner Lock cells and Withdrawal Requests are supported
            //Check if it's an owner lock cell
            if (ownedCell.cellOutput.type == undefined) {
                ownedCells.push(ownedCell);
                continue;
            }
            //Check if is a withdrawal request
            if ((0, lumos_utils_1.isDAOWithdrawal)(ownedCell)) {
                const maturityEpoch = (0, lumos_utils_1.parseEpoch)(await transactionBuilder.withdrawedDaoSince(ownedCell));
                if ((0, lumos_utils_1.epochCompare)(maturityEpoch, tipEpoch) < 1) { //Withdrawal request is ripe
                    ownedCells.push(ownedCell);
                    continue;
                }
            }
            //Due to the receipt script constraints either all or no owned cells can be unlocked
            ownedCells = [];
            break;
        }
        transactionBuilder.add("input", "end", receiptCell, ...ownedCells);
        if (await is_well_funded()) {
            return transactionBuilder;
        }
    }
    //Try adding iCKB SUDT and see if it helps
    for await (const sudtCell of new ckb_indexer_1.CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        type: (0, domain_logic_1.ickbSudtType)(),
        lock: transactionBuilder.getAccountLock()
    }).collect()) {
        transactionBuilder.add("input", "end", sudtCell);
        if (await is_well_funded()) {
            return transactionBuilder;
        }
    }
    return (0, lumos_utils_1.fund)(transactionBuilder);
}
exports.fund = fund;
//# sourceMappingURL=actions.js.map