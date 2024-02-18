import { Cell, Hash, HexString } from "@ckb-lumos/base";
import { Byte32 } from "@ckb-lumos/base/lib/blockchain";
import { EpochSinceValue, parseAbsoluteEpochSince, parseEpoch } from "@ckb-lumos/base/lib/since";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi";
import { createBytesCodec, createFixedBytesCodec } from "@ckb-lumos/codec";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { array, struct } from "@ckb-lumos/codec/lib/molecule/layout";
import { Uint128LE, Uint8 } from "@ckb-lumos/codec/lib/number/uint";
import { extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { TransactionSkeleton, TransactionSkeletonType, minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import {
    Assets, I8Cell, I8Header, I8Script, addAsset, addCells, capacitySifter, createUintBICodec,
    daoDeposit, daoRequestWithdrawalFrom, daoRequestWithdrawalWith, daoSifter, daoWithdrawFrom, defaultScript,
    epochSinceCompare, errorUndefinedBlockNumber, headerDeps, isDaoDeposit, logSplit, scriptEq, since
} from "@ickb/lumos-utils";

export type ReceiptGroups = {
    receipts: I8Cell[],
    capacities: I8Cell[],
    withdrawalRequests: I8Cell[]
};

export function ickbSifter(
    inputs: readonly Cell[],
    accountLockExpander: (c: Cell) => I8Script | undefined,
    getHeader: (blockNumber: string, context: Cell) => I8Header
) {
    const ickbSudt = ickbSudtType();
    const ickbLogic = ickbLogicScript();

    const sudts: I8Cell[] = [];
    const receipts: I8Cell[] = [];
    let capacities: I8Cell[] = [];
    let withdrawalRequests: I8Cell[] = [];
    let ickbDepositPool: I8Cell[] = [];
    let unknowns: Cell[] = [];
    for (const c of inputs) {
        const accountLock = accountLockExpander(c);
        if (!accountLock) {
            unknowns.push(c);
            continue
        }
        if (scriptEq(c.cellOutput.type, ickbSudt)) {
            sudts.push(I8Cell.from({
                ...c,
                cellOutput: {
                    lock: accountLock,
                    type: ickbSudt,
                    capacity: c.cellOutput.capacity
                }
            }));
            continue;
        }
        if (!scriptEq(c.cellOutput.type, ickbLogic)) {
            unknowns.push(c);
            continue
        }

        if (!c.blockNumber) {
            throw Error(errorUndefinedBlockNumber);
        }

        receipts.push(
            I8Cell.from({
                ...c,
                cellOutput: {
                    lock: accountLock,
                    type: I8Script.from({
                        ...ickbLogic,
                        [headerDeps]: [getHeader(c.blockNumber, c)]
                    }),
                    capacity: c.cellOutput.capacity
                }
            })
        );
    }

    const ickbLogicExpander = (c: Cell) => (scriptEq(c.cellOutput.lock, ickbLogic) ? ickbLogic : undefined);
    ({ capacities, notCapacities: unknowns } = capacitySifter(unknowns, ickbLogicExpander));

    ({
        deposits: ickbDepositPool,
        withdrawalRequests,
        notDaos: unknowns
    } = daoSifter(unknowns, ickbLogicExpander, getHeader));

    //Filter owned cells by tx hash of receipts
    const txHash2OwnedQuantity = receiptOwned(receipts);
    for (const cc of [capacities, withdrawalRequests]) {
        const cloned = [...cc];
        cc.length = 0;
        for (const c of cloned) {
            if (txHash2OwnedQuantity.has(c.outPoint!.txHash)) {
                cc.push(c);
            } else {
                unknowns.push(c);
            }
        }
    }

    return {
        sudts,
        receiptGroups: <ReceiptGroups>{
            receipts,
            capacities,
            withdrawalRequests
        },
        ickbDepositPool,
        notIckbs: unknowns
    };
}

function receiptOwned(receipts: Cell[]) {
    const txHash2OwnedQuantity = new Map<Hash, number>();
    for (const r of receipts) {
        const { ownedQuantity, unspent } = ReceiptDataCodec.unpack(r.data);
        if (ownedQuantity > 0) {
            txHash2OwnedQuantity.set(r.outPoint!.txHash, ownedQuantity);
        }
        for (const { txHash, ownedQuantity } of unspent) {
            txHash2OwnedQuantity.set(txHash, ownedQuantity);
        }
    }
    return txHash2OwnedQuantity;
}

export function ickbDeposit(tx: TransactionSkeletonType, depositQuantity: number, header: I8Header) {
    const depositAmount = ckbSoftCapPerDeposit(header);
    return daoDeposit(tx, Array(depositQuantity).fill(depositAmount), ickbLogicScript());
}

export function ickbRequestWithdrawalFrom(tx: TransactionSkeletonType, ickbDepositPool: readonly I8Cell[]) {
    return daoRequestWithdrawalFrom(tx, ickbDepositPool, ickbLogicScript());
}

export function ickbRequestWithdrawalWith(
    tx: TransactionSkeletonType,
    ickbDepositPool: readonly I8Cell[],
    tipHeader: I8Header,
    maxIckbWithdrawalAmount: BI,
    maxWithdrawalCells: number = Number.POSITIVE_INFINITY,
    minLock?: EpochSinceValue,
    maxLock?: EpochSinceValue,
) {
    return daoRequestWithdrawalWith(
        tx,
        ickbDepositPool,
        ickbLogicScript(),
        tipHeader,
        ickb2Ckb(maxIckbWithdrawalAmount, tipHeader),
        maxWithdrawalCells,
        minLock,
        maxLock
    );
}

export const errorOwnedReceiptMismatch = "Inputs contains a owned cell that do not match with a receipt";
export function ickbSudtFundAdapter(
    assets: Assets,
    accountLock: I8Script,
    sudts: readonly I8Cell[],
    tipHeader?: I8Header,
    receiptGroups?: ReceiptGroups
): Assets {
    const getDelta = (tx: TransactionSkeletonType) => ickbDelta(tx);

    const addChange = (tx: TransactionSkeletonType) => {
        const delta = getDelta(tx);
        if (delta.lt(0)) {
            return undefined;
        }

        //Group output cells that the receipt has to account for
        const ickbDeposits: Cell[] = [];
        const ownedCells: Cell[] = [];
        for (const cell of tx.outputs.filter((c) => scriptEq(c.cellOutput.lock, ickbLogicScript()))) {
            if (isDaoDeposit(cell)) {
                ickbDeposits.push(cell);
            } else {
                ownedCells.push(cell);
            }
        }

        //Maybe add an Owner Lock cell to enable later conversion from Receipt to iCKB
        if (ickbDeposits.length > 0) {
            const ownerLockCell = I8Cell.from({ lock: ickbLogicScript() })
            tx = addCells(tx, "append", [], [ownerLockCell])
            ownedCells.push(ownerLockCell);
        }

        //Maybe add unspent owned cells accounting
        const inputReceipts = tx.inputs.filter((c) => scriptEq(c.cellOutput.type, ickbLogicScript()));
        const txHash2OwnedQuantity = receiptOwned(inputReceipts.toArray());
        for (const c of tx.inputs) {
            if (!scriptEq(c.cellOutput.lock, ickbLogicScript()) || isDaoDeposit(c)) {
                continue;
            }
            const txHash = c.outPoint!.txHash;
            const n = txHash2OwnedQuantity.get(txHash);
            if (n === undefined) {
                throw Error(errorOwnedReceiptMismatch);
            }
            if (n > 1) {
                txHash2OwnedQuantity.set(txHash, n - 1);
            } else {
                txHash2OwnedQuantity.delete(txHash);
            }
        }
        const unspent = ([...txHash2OwnedQuantity.entries()] as [string, number][])
            .map(([txHash, ownedQuantity]) => Object.freeze({ txHash, ownedQuantity }));

        //Maybe add iCKB receipt cell
        if (ownedCells.length > 0 || unspent.length > 0) {
            const data = hexify(ReceiptDataCodec.pack({
                depositAmount: ickbDeposits.length > 0 ?
                    BI.from(ickbDeposits[0].cellOutput.capacity)
                        .sub(minimalCellCapacityCompatible(ickbDeposits[0]))
                    : BI.from(0),
                depositQuantity: ickbDeposits.length,
                ownedQuantity: ownedCells.length,
                unspent
            }));

            const receipt = I8Cell.from({ lock: accountLock, type: ickbLogicScript(), data });
            tx = addCells(tx, "append", [], [receipt]);
        }

        if (delta.eq(0)) {
            return tx;
        }

        //Add SUDT change cell
        const changeCell = I8Cell.from({
            lock: accountLock,
            type: ickbSudtType(),
            data: hexify(Uint128LE.pack(delta))
        });
        return addCells(tx, "append", [], [changeCell]);
    }


    const addFunds: ((tx: TransactionSkeletonType) => TransactionSkeletonType)[] = [];

    for (const ss of logSplit(sudts)) {
        addFunds.push((tx: TransactionSkeletonType) => addCells(tx, "append", ss, []));
    }

    const unavailableCells: I8Cell[] = [];
    if (tipHeader && receiptGroups) {
        const tipEpoch = parseEpoch(tipHeader.epoch);
        const { receipts, capacities, withdrawalRequests } = receiptGroups;
        const ripeWithdrawalRequests: I8Cell[] = [];
        for (const wr of withdrawalRequests) {
            const withdrawalEpoch = parseAbsoluteEpochSince(wr.cellOutput.type![since]);
            if (epochSinceCompare(tipEpoch, withdrawalEpoch) === -1) {
                unavailableCells.push(wr);
            } else {
                ripeWithdrawalRequests.push(wr);
            }
        }

        if (ripeWithdrawalRequests.length == 0 && capacities.length == 0) {
            unavailableCells.push(...receipts);
        } else {
            addFunds.push((tx: TransactionSkeletonType) => {
                tx = daoWithdrawFrom(tx, ripeWithdrawalRequests);
                tx = addCells(tx, "append", [...receipts, ...capacities], []);
                return tx;
            });
        }
    }

    const unavailableFunds = [TransactionSkeleton().update("inputs", i => i.push(...unavailableCells))];

    return addAsset(assets, "ICKB_SUDT", getDelta, addChange, addFunds, unavailableFunds);
}

export function ickbDelta(tx: TransactionSkeletonType) {
    let ickbDelta = BI.from(0);
    for (const c of tx.inputs) {
        //iCKB token
        if (scriptEq(c.cellOutput.type, ickbSudtType())) {
            ickbDelta = ickbDelta.add(Uint128LE.unpack(c.data));
            continue;
        }

        //Withdrawal from iCKB pool of NervosDAO deposits
        if (scriptEq(c.cellOutput.lock, ickbLogicScript()) && isDaoDeposit(c)) {
            const header = (c as I8Cell).cellOutput.type![headerDeps][0];
            const ckbUnoccupiedCapacity = BI.from(c.cellOutput.capacity).sub(minimalCellCapacityCompatible(c));
            ickbDelta = ickbDelta.sub(ickbDepositValue(ckbUnoccupiedCapacity, header));
            continue;
        }

        //iCKB Receipt
        if (scriptEq(c.cellOutput.type, ickbLogicScript())) {
            const header = (c as I8Cell).cellOutput.type![headerDeps][0];
            const { depositQuantity, depositAmount } = ReceiptDataCodec.unpack(c.data);
            ickbDelta = ickbDelta.add(ickbReceiptValue(depositQuantity, depositAmount, header));
        }
    }

    for (const c of tx.outputs) {
        //iCKB token
        if (scriptEq(c.cellOutput.type, ickbSudtType())) {
            ickbDelta = ickbDelta.sub(Uint128LE.unpack(c.data));
        }
    }

    return ickbDelta;
}

export function ickbSudtType() {
    return I8Script.from({ ...defaultScript("SUDT"), args: computeScriptHash(ickbLogicScript()) });
}

export function ickbLogicScript() {
    return defaultScript("ICKB_LOGIC");
}

const PositiveUint8 = createFixedBytesCodec<number, BIish>(
    {
        byteLength: Uint8.byteLength,
        pack: (packable) => Uint8.pack(BI.from(-1).add(packable)),
        unpack: (unpackable) => Uint8.unpack(unpackable) + 1,
    },
);

const Uint48LE = createUintBICodec(6, true);

export type PackableReceiptData = {
    depositAmount: BI,          //  6 bytes
    depositQuantity: number,    //  1 byte
    ownedQuantity: number,      //  1 byte
    unspent: {
        txHash: HexString,      // 32 bytes
        ownedQuantity: number,  //  1 byte
    }[]
};
const newParametricReceiptDataCodec = (unspentLength: number) => {
    const unspentCodec = struct(
        {
            txHash: Byte32,
            ownedQuantity: PositiveUint8,
        },
        ["txHash", "ownedQuantity"]
    );

    const parametricUnspentCodec = array(unspentCodec, unspentLength);

    return struct(
        {
            depositAmount: Uint48LE,
            depositQuantity: Uint8,
            ownedQuantity: Uint8,
            unspent: parametricUnspentCodec
        },
        ["depositAmount", "depositQuantity", "ownedQuantity", "unspent"]
    );
}

const size = 100;
const receiptDataCodecs = Object.freeze(Array.from({ length: size }, (_, i) => newParametricReceiptDataCodec(i)));
export const ReceiptDataCodec = createBytesCodec<PackableReceiptData>({
    pack: (packable) => {
        const n = packable.unspent.length;
        return (n < size ? receiptDataCodecs[n] : newParametricReceiptDataCodec(n)).pack(packable);
    },
    unpack: (packed) => {
        const n = (packed.length - receiptDataCodecs[0].byteLength) / 33;
        return (n < size ? receiptDataCodecs[n] : newParametricReceiptDataCodec(n)).unpack(packed);
    }
});

export const ICKB_SOFT_CAP_PER_DEPOSIT = parseUnit("100000", "ckb");
export function ickbDepositValue(ckbUnoccupiedCapacity: BI, header: I8Header) {
    let ickbAmount = ckb2Ickb(ckbUnoccupiedCapacity, header, false);
    if (ICKB_SOFT_CAP_PER_DEPOSIT.lt(ickbAmount)) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickbAmount = ickbAmount.sub(ickbAmount.sub(ICKB_SOFT_CAP_PER_DEPOSIT).div(10));
    }

    return ickbAmount;
}

export function ickbReceiptValue(receiptCount: BIish, receiptAmount: BI, header: I8Header) {
    return ickbDepositValue(receiptAmount, header).mul(receiptCount);
}

export function ckbSoftCapPerDeposit(header: I8Header) {
    return ickb2Ckb(ICKB_SOFT_CAP_PER_DEPOSIT, header);
}

export function ckb2Ickb(ckbAmount: BI, header: I8Header, accountDepositCapacity = true) {
    const { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(header, accountDepositCapacity);
    return ckbAmount.mul(ckbMultiplier).div(sudtMultiplier);
}

export function ickb2Ckb(sudtAmount: BI, header: I8Header, accountDepositCapacity = true) {
    const { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(header, accountDepositCapacity);
    return sudtAmount.mul(sudtMultiplier).div(ckbMultiplier);
}

const AR_0 = BI.from("10000000000000000");
const depositCapacityMultiplier = parseUnit("82", "ckb").mul(AR_0).div(ICKB_SOFT_CAP_PER_DEPOSIT);
export function ickbExchangeRatio(header: I8Header, accountDepositCapacity = true) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];
    return {
        ckbMultiplier: AR_0,
        sudtMultiplier: accountDepositCapacity ? AR_m.add(depositCapacityMultiplier) : AR_m
    }
}