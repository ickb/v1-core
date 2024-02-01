import { Cell, Hash } from "@ckb-lumos/base";
import { EpochSinceValue, parseAbsoluteEpochSince, parseEpoch } from "@ckb-lumos/base/lib/since";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule/layout";
import { Uint128LE, Uint8 } from "@ckb-lumos/codec/lib/number/uint";
import { extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { TransactionSkeleton, TransactionSkeletonType, minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import {
    Assets,
    I8Cell, I8Header, I8Script, addAsset, addCells, capacitiesSifter, createUintBICodec,
    daoDeposit, daoRequestWithdrawalFrom, daoRequestWithdrawalWith, daoSifter, daoWithdrawFrom, defaultScript,
    epochSinceCompare, errorUndefinedBlockNumber, headerDeps, isDaoDeposit, logSplit, scriptEq, since
} from "@ickb/lumos-utils";

export type IckbGroup = {
    receipt: I8Cell,
    capacities: readonly I8Cell[],
    withdrawalRequests: readonly I8Cell[]
};

export function ickbSifter(
    inputs: readonly Cell[],
    accountLockExpander: (c: Cell) => I8Script | undefined,
    getHeader: (blockNumber: string, context: Cell) => I8Header
) {
    const ickbSudt = ickbSudtType();
    const ickbLogic = ickbLogicScript();

    const ickbLogicExpander = (c: Cell) => (scriptEq(c.cellOutput.lock, ickbLogic) ? ickbLogic : undefined);
    const { owned: capacities, unknowns: inputs1 } = capacitiesSifter(inputs, ickbLogicExpander);
    const {
        deposits: ickbDeposits,
        withdrawalRequests,
        unknowns: inputs2
    } = daoSifter(inputs1, ickbLogicExpander, getHeader);

    const txHash2Capacities = groupByTxHash(capacities);
    const txHash2WithdrawalRequests = groupByTxHash(withdrawalRequests);

    const sudts: I8Cell[] = [];
    const ickbGroups: IckbGroup[] = [];
    const unknowns: Cell[] = [];
    for (const c of inputs2) {
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

        const txHash = c.outPoint!.txHash;
        const capacities = txHash2Capacities.get(txHash) ?? [];
        const withdrawalRequests = txHash2WithdrawalRequests.get(txHash) ?? [];

        const { ownedQuantity } = ReceiptCodec.unpack(c.data);
        if (capacities.length + withdrawalRequests.length != ownedQuantity) {
            unknowns.push(c)
            continue;
        }
        txHash2Capacities.delete(txHash);
        txHash2WithdrawalRequests.delete(txHash);

        const receipt = I8Cell.from({
            ...c,
            cellOutput: {
                lock: accountLock,
                type: I8Script.from({
                    ...ickbLogic,
                    [headerDeps]: [getHeader(c.blockNumber, c)]
                }),
                capacity: c.cellOutput.capacity
            }
        });

        ickbGroups.push(Object.freeze({
            receipt,
            capacities: Object.freeze(capacities),
            withdrawalRequests: Object.freeze(withdrawalRequests)
        }));
    }

    for (const c of [...txHash2Capacities.values(), ...txHash2WithdrawalRequests.values()].flat()) {
        unknowns.push(c);
    }

    return { ickbGroups, sudts, ickbDeposits, unknowns };
}

function groupByTxHash(cells: I8Cell[]) {
    const result = new Map<Hash, I8Cell[]>();
    for (const c of cells) {
        result.set(c.outPoint!.txHash, [...result.get(c.outPoint!.txHash) ?? [], c]);
    }
    return result;
}

export function ickbDeposit(tx: TransactionSkeletonType, depositQuantity: number, header: I8Header) {
    const depositAmount = ckbSoftCapPerDeposit(header);
    return daoDeposit(tx, Array(depositQuantity).fill(depositAmount), ickbLogicScript());
}

export function ickbRequestWithdrawalFrom(tx: TransactionSkeletonType, deposits: readonly I8Cell[]) {
    return daoRequestWithdrawalFrom(tx, deposits, ickbLogicScript());
}

export function ickbRequestWithdrawalWith(
    tx: TransactionSkeletonType,
    deposits: readonly I8Cell[],
    tipHeader: I8Header,
    maxIckbWithdrawalAmount: BI,
    maxWithdrawalCells: number = Number.POSITIVE_INFINITY,
    minLock: EpochSinceValue = { length: 16, index: 1, number: 0 },// 1/8 epoch (~ 15 minutes)
    maxLock: EpochSinceValue = { length: 4, index: 1, number: 0 }// 1/4 epoch (~ 1 hour)
) {
    return daoRequestWithdrawalWith(
        tx,
        deposits,
        ickbLogicScript(),
        tipHeader,
        ickb2Ckb(maxIckbWithdrawalAmount, tipHeader),
        maxWithdrawalCells,
        minLock,
        maxLock
    );
}

export function ickbSudtFundAdapter(
    assets: Assets,
    accountLock: I8Script,
    sudts: readonly I8Cell[],
    tipHeader?: I8Header,
    ickbGroups?: readonly IckbGroup[]
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
        if (ickbDeposits.length > 0 && ownedCells.length == 0) {
            const ownerLockCell = I8Cell.from({ lock: ickbLogicScript() })
            tx = addCells(tx, "append", [], [ownerLockCell])
            ownedCells.push(ownerLockCell);
        }

        //Maybe add iCKB receipt cell
        if (ownedCells.length > 0) {
            const data = hexify(ReceiptCodec.pack({
                ownedQuantity: ownedCells.length,
                depositQuantity: ickbDeposits.length,
                depositAmount: ickbDeposits.length > 0 ?
                    BI.from(ickbDeposits[0].cellOutput.capacity)
                        .sub(minimalCellCapacityCompatible(ickbDeposits[0]))
                    : BI.from(0)
            }))

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

    const unavailableGroups: I8Cell[] = [];
    if (tipHeader && ickbGroups) {
        const tipEpoch = parseEpoch(tipHeader.epoch);
        const availableGroups: IckbGroup[] = [];
        for (const g of ickbGroups) {
            const { receipt, withdrawalRequests, capacities: owned } = g;
            const someAreNotReady = withdrawalRequests.some(wr => {
                const withdrawalEpoch = parseAbsoluteEpochSince(wr.cellOutput.type![since]);
                return epochSinceCompare(tipEpoch, withdrawalEpoch) === -1
            });
            if (someAreNotReady) {
                unavailableGroups.push(receipt, ...withdrawalRequests, ...owned)
                continue;
            }
            availableGroups.push(g);
        }
        for (const gg of logSplit(availableGroups)) {
            const receipt: I8Cell[] = [];
            const withdrawalRequests: I8Cell[] = [];
            const capacities: I8Cell[] = [];
            for (const { receipt: r, withdrawalRequests: wr, capacities: c } of gg) {
                receipt.push(r);
                withdrawalRequests.push(...wr);
                capacities.push(...c);
            }
            addFunds.push((tx: TransactionSkeletonType) => {
                tx = daoWithdrawFrom(tx, withdrawalRequests);
                tx = addCells(tx, "append", [...receipt, ...capacities], []);
                return tx;
            });
        }

    }

    const unavailableFunds = [TransactionSkeleton().update("inputs", i => i.push(...unavailableGroups))];

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
            const { depositQuantity, depositAmount } = ReceiptCodec.unpack(c.data);
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

export const ReceiptCodec = struct(
    {
        ownedQuantity: Uint8,
        depositQuantity: Uint8,
        depositAmount: createUintBICodec(6, true),
    },
    ["ownedQuantity", "depositQuantity", "depositAmount"]
);

export const ICKB_SOFT_CAP_PER_DEPOSIT = parseUnit("100000", "ckb");
export function ickbDepositValue(ckbUnoccupiedCapacity: BI, header: I8Header) {
    let ickbAmount = ckb2Ickb(ckbUnoccupiedCapacity, header);
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
    return ckb2Ickb(ICKB_SOFT_CAP_PER_DEPOSIT, header);
}

export function ckb2Ickb(ckbAmount: BI, header: I8Header) {
    const { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(header);
    return ckbAmount.mul(ckbMultiplier).div(sudtMultiplier);
}

export function ickb2Ckb(sudtAmount: BI, header: I8Header) {
    const { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(header);
    return sudtAmount.mul(sudtMultiplier).div(ckbMultiplier).add(1);
}

const AR_0 = BI.from("10000000000000000");
export function ickbExchangeRatio(header: I8Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];
    return {
        ckbMultiplier: AR_0,
        sudtMultiplier: AR_m
    }
}