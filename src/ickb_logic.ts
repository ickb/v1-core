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
    epochSinceCompare, errorUndefinedBlockNumber, headerDeps, isDaoDeposit, scriptEq, since
} from "@ickb/lumos-utils";

export type IckbGroup = {
    receipt: I8Cell,
    capacities: readonly I8Cell[],
    withdrawalRequests: readonly I8Cell[]
};

export function ickbSifter(
    inputs: Iterable<Cell>,
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

export function ickbRequestWithdrawalFrom(tx: TransactionSkeletonType, deposits: Iterable<I8Cell>) {
    return daoRequestWithdrawalFrom(tx, deposits, ickbLogicScript());
}

export function ickbRequestWithdrawalWith(
    tx: TransactionSkeletonType,
    deposits: Iterable<I8Cell>,
    tipHeader: I8Header,
    maxWithdrawalAmount: BI,
    maxWithdrawalCells: number = Number.POSITIVE_INFINITY,
    minLock: EpochSinceValue = { length: 16, index: 1, number: 0 },// 1/8 epoch (~ 15 minutes)
    maxLock: EpochSinceValue = { length: 4, index: 1, number: 0 }// 1/4 epoch (~ 1 hour)
) {
    return daoRequestWithdrawalWith(
        tx,
        deposits,
        ickbLogicScript(),
        tipHeader,
        maxWithdrawalAmount,
        maxWithdrawalCells,
        minLock,
        maxLock
    );
}

export function ickbSudtFundAdapter(
    assets: Assets,
    accountLock: I8Script,
    sudts: Iterable<I8Cell>,
    tipHeader?: I8Header,
    ickbGroups?: Iterable<IckbGroup>
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
    const unavailableGroups: I8Cell[] = [];
    if (tipHeader && ickbGroups) {
        const tipEpoch = parseEpoch(tipHeader.epoch)
        for (const { receipt, withdrawalRequests, capacities: owned } of ickbGroups) {
            const someAreNotReady = withdrawalRequests.some(wr => {
                const withdrawalEpoch = parseAbsoluteEpochSince(wr.cellOutput.type![since]);
                return epochSinceCompare(tipEpoch, withdrawalEpoch) === -1
            });
            if (someAreNotReady) {
                unavailableGroups.push(receipt, ...withdrawalRequests, ...owned)
                continue;
            }

            addFunds.push((tx: TransactionSkeletonType) => {
                tx = daoWithdrawFrom(tx, withdrawalRequests);
                tx = addCells(tx, "append", [receipt, ...owned], [])
                return tx;
            });
        }
    }

    for (const c of sudts) {
        addFunds.push((tx: TransactionSkeletonType) => addCells(tx, "append", [c], []));
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
            ickbDelta = ickbDelta.sub(ickbEquivalentValue(ckbUnoccupiedCapacity, header));
            continue;
        }

        //iCKB Receipt
        if (scriptEq(c.cellOutput.type, ickbLogicScript())) {
            const header = (c as I8Cell).cellOutput.type![headerDeps][0];
            const { depositQuantity, depositAmount } = ReceiptCodec.unpack(c.data);
            ickbDelta = ickbDelta.add(receiptIckbEquivalentValue(depositQuantity, depositAmount, header));
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

export const AR_0 = BI.from("10000000000000000");
export const ICKB_SOFT_CAP_PER_DEPOSIT = parseUnit("100000", "ckb");

export function ickbEquivalentValue(ckbUnoccupiedCapacity: BI, header: I8Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    let ickbAmount = ckbUnoccupiedCapacity.mul(AR_0).div(AR_m);
    if (ICKB_SOFT_CAP_PER_DEPOSIT.lt(ickbAmount)) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickbAmount = ickbAmount.sub(ickbAmount.sub(ICKB_SOFT_CAP_PER_DEPOSIT).div(10));
    }

    return ickbAmount;
}

export function receiptIckbEquivalentValue(receiptCount: BIish, receiptAmount: BI, header: I8Header) {
    return ickbEquivalentValue(receiptAmount, header).mul(receiptCount);
}

export function ckbSoftCapPerDeposit(header: I8Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    return ICKB_SOFT_CAP_PER_DEPOSIT.mul(AR_m).div(AR_0).add(1);
}