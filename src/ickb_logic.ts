import type { Cell, OutPoint } from "@ckb-lumos/base";
import { type EpochSinceValue, parseAbsoluteEpochSince, parseEpoch } from "@ckb-lumos/base/lib/since.js";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils.js";
import { hexify } from "@ckb-lumos/codec/lib/bytes.js";
import { extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao.js";
import { TransactionSkeleton, type TransactionSkeletonType, minimalCellCapacity } from "@ckb-lumos/helpers";
import {
    type Assets, I8Cell, I8Header, I8Script, addAsset, addCells, daoDeposit, daoRequestWithdrawalFrom,
    daoRequestWithdrawalWith, daoSifter, daoWithdrawFrom, defaultScript, epochSinceCompare, errorUndefinedBlockNumber,
    headerDeps, isDaoDeposit, logSplit, scriptEq, since, typeSifter, isDaoWithdrawalRequest, lockExpanderFrom, hex,
    ckbInShannons, Uint128
} from "@ickb/lumos-utils";
import { OwnedOwnerData, ReceiptData, UdtData } from "./encoding.js";

export type WithdrawalRequestGroup = Readonly<{
    ownedWithdrawalRequest: I8Cell,
    owner: I8Cell,
}>;


export function ickbSifter(
    inputs: readonly Cell[],
    accountLockExpander: (c: Cell) => I8Script | undefined,
    getHeader: (blockNumber: string, context: Cell) => I8Header
) {
    const ickbUdt = ickbUdtType();
    const ickbLogic = ickbLogicScript();

    const udts: I8Cell[] = [];
    const receipts: I8Cell[] = [];
    let withdrawalRequests: I8Cell[] = [];
    let ickbDepositPool: I8Cell[] = [];
    let unknowns: Cell[] = [];
    for (const c of inputs) {
        const accountLock = accountLockExpander(c);
        if (!accountLock) {
            unknowns.push(c);
            continue
        }
        if (scriptEq(c.cellOutput.type, ickbUdt)) {
            udts.push(I8Cell.from({
                ...c,
                cellOutput: {
                    lock: accountLock,
                    type: ickbUdt,
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

    let unknowns_: I8Cell[];
    ({
        deposits: ickbDepositPool,
        withdrawalRequests: unknowns_,
        notDaos: unknowns
    } = daoSifter(unknowns, lockExpanderFrom(ickbLogic), getHeader));
    unknowns = unknowns.concat(unknowns_);

    const ownedOwner = ownedOwnerScript();
    ({
        deposits: unknowns_,
        withdrawalRequests,
        notDaos: unknowns
    } = daoSifter(unknowns, lockExpanderFrom(ownedOwner), getHeader));
    unknowns = unknowns.concat(unknowns_);

    let owners: I8Cell[];
    ({ types: owners, notTypes: unknowns } = typeSifter(unknowns, ownedOwner, accountLockExpander));

    const key = (o: OutPoint) => o.txHash + o.index;
    const outPoint2withdrawalRequests = new Map(withdrawalRequests.map(c => [key(c.outPoint!), c]));
    const withdrawalRequestGroups: WithdrawalRequestGroup[] = [];
    for (const owner of owners) {
        const { ownedDistance } = OwnedOwnerData.unpack(owner.data);
        const index = hex(Number(owner.outPoint!.index) + ownedDistance);
        const k = key({ ...owner.outPoint!, index });
        const ownedWithdrawalRequest = outPoint2withdrawalRequests.get(k);

        if (ownedWithdrawalRequest) {
            withdrawalRequestGroups.push(Object.freeze({ owner, ownedWithdrawalRequest }));
            outPoint2withdrawalRequests.delete(k);
        } else {
            unknowns.push(owner);
        }
    }
    unknowns = unknowns.concat(Array.from(outPoint2withdrawalRequests.values()));

    return {
        udts,
        receipts,
        withdrawalRequestGroups,
        ickbDepositPool,
        notIckbs: unknowns
    };
}

export function ickbDeposit(tx: TransactionSkeletonType, depositQuantity: number, header: I8Header) {
    const depositAmount = ckbSoftCapPerDeposit(header);
    return daoDeposit(tx, Array(depositQuantity).fill(depositAmount), ickbLogicScript());
}

export function ickbRequestWithdrawalFrom(tx: TransactionSkeletonType, ickbDepositPool: readonly I8Cell[]) {
    return daoRequestWithdrawalFrom(tx, ickbDepositPool, ownedOwnerScript());
}

export function ickbRequestWithdrawalWith(
    tx: TransactionSkeletonType,
    ickbDepositPool: readonly I8Cell[],
    tipHeader: I8Header,
    maxIckbWithdrawalAmount: bigint,
    maxWithdrawalCells: number = Number.POSITIVE_INFINITY,
    minLock?: EpochSinceValue,
    maxLock?: EpochSinceValue,
) {
    return daoRequestWithdrawalWith(
        tx,
        ickbDepositPool,
        ownedOwnerScript(),
        tipHeader,
        ickb2Ckb(maxIckbWithdrawalAmount, tipHeader),
        maxWithdrawalCells,
        minLock,
        maxLock
    );
}

export function ickbFundAdapter(
    assets: Assets,
    accountLock: I8Script,
    udts: readonly I8Cell[],
    tipHeader?: I8Header,
    receipts?: readonly I8Cell[],
    withdrawalRequestGroups?: readonly WithdrawalRequestGroup[]
): Assets {
    const getDelta = (tx: TransactionSkeletonType) => ickbDelta(tx);

    const addChange = (tx: TransactionSkeletonType, minChange: bigint) => {
        const delta = getDelta(tx);
        if (delta < minChange) {
            return undefined;
        }

        //Change cells
        const cc: I8Cell[] = [];

        //Owned iCKB Withdrawal Requests for which need to be created an Owner cell
        const ownedOwner = ownedOwnerScript();
        for (const [index, c] of tx.outputs.entries()) {
            if (!isDaoWithdrawalRequest(c) || !scriptEq(c.cellOutput.lock, ownedOwner)) {
                continue;
            }
            const ownerIndex = tx.outputs.size + cc.length;
            const ownedDistance = index - ownerIndex;
            cc.push(I8Cell.from({
                lock: accountLock,
                type: ownedOwner,
                data: hexify(OwnedOwnerData.pack({ ownedDistance }))
            }));
        }

        //Add receipts for iCKB Deposits
        const ickbLogic = ickbLogicScript();
        const depositAmount2Quantity = new Map<bigint, ReturnType<typeof ReceiptData.unpack>>();
        for (const c of tx.outputs) {
            if (!isDaoDeposit(c) || !scriptEq(c.cellOutput.lock, ickbLogic)) {
                continue;
            }

            const usedCapacity = minimalCellCapacity(c, { validate: false });
            const depositAmount = BigInt(c.cellOutput.capacity) - BigInt(usedCapacity);
            let v = depositAmount2Quantity.get(depositAmount);
            if (v) {
                v.value.depositQuantity += 1;
            } else {
                depositAmount2Quantity.set(depositAmount, {
                    type: "ReceiptDataV0",
                    value: {
                        depositQuantity: 1,
                        depositAmount,
                    }
                });
            }
        }
        for (const d of depositAmount2Quantity.values()) {
            cc.push(I8Cell.from({
                lock: accountLock,
                type: ickbLogic,
                data: hexify(ReceiptData.pack(d))
            }));
        }

        //Add UDT change cell
        if (delta != 0n) {
            cc.push(I8Cell.from({
                lock: accountLock,
                type: ickbUdtType(),
                data: hexify(UdtData.pack({ udtAmount: delta }))
            }));
        }

        //Append change cells to the transaction
        return addCells(tx, "append", [], cc);
    }

    const addFunds: ((tx: TransactionSkeletonType) => TransactionSkeletonType)[] = [];

    for (const uu of logSplit(udts)) {
        addFunds.push((tx: TransactionSkeletonType) => addCells(tx, "append", uu, []));
    }

    const unavailableCells: I8Cell[] = [];
    if (tipHeader && receipts && withdrawalRequestGroups) {
        const tipEpoch = parseEpoch(tipHeader.epoch);
        const ripeWithdrawalRequests: I8Cell[] = [];
        const ripeOwners: I8Cell[] = [];
        for (const { ownedWithdrawalRequest, owner } of withdrawalRequestGroups) {
            const withdrawalEpoch = parseAbsoluteEpochSince(ownedWithdrawalRequest.cellOutput.type![since]);
            if (epochSinceCompare(tipEpoch, withdrawalEpoch) === -1) {
                unavailableCells.push(ownedWithdrawalRequest, owner);
            } else {
                ripeWithdrawalRequests.push(ownedWithdrawalRequest);
                ripeOwners.push(owner);
            }
        }

        if (ripeWithdrawalRequests.length > 0) {
            addFunds.push((tx: TransactionSkeletonType) => {
                tx = daoWithdrawFrom(tx, ripeWithdrawalRequests);
                tx = addCells(tx, "append", ripeOwners, []);
                return tx;
            });
        }
    }

    const unavailableFunds = [TransactionSkeleton().update("inputs", i => i.push(...unavailableCells))];

    return addAsset(assets, "ICKB_UDT", getDelta, addChange, addFunds, unavailableFunds);
}

export function ickbDelta(tx: TransactionSkeletonType) {
    const ickbUdt = ickbUdtType();
    const ickbLogic = ickbLogicScript();
    let ickbDelta = 0n;
    for (const c of tx.inputs) {
        //iCKB token
        if (scriptEq(c.cellOutput.type, ickbUdt)) {
            ickbDelta += Uint128.unpack(c.data);
            continue;
        }

        //Withdrawal from iCKB pool of NervosDAO deposits
        if (scriptEq(c.cellOutput.lock, ickbLogic) && isDaoDeposit(c)) {
            const header = (c as I8Cell).cellOutput.type![headerDeps][0];
            const ckbUnoccupiedCapacity = BigInt(c.cellOutput.capacity) - minimalCellCapacity(c);
            ickbDelta -= ickbDepositValue(ckbUnoccupiedCapacity, header);
            continue;
        }

        //iCKB Receipt
        if (scriptEq(c.cellOutput.type, ickbLogic)) {
            const header = (c as I8Cell).cellOutput.type![headerDeps][0];
            const { depositQuantity, depositAmount } = ReceiptData.unpack(c.data).value;
            ickbDelta += ickbReceiptValue(depositQuantity, depositAmount, header);
        }
    }

    for (const c of tx.outputs) {
        //iCKB token
        if (scriptEq(c.cellOutput.type, ickbUdt)) {
            ickbDelta -= Uint128.unpack(c.data);
        }
    }

    return ickbDelta;
}

export function ickbUdtType() {
    return I8Script.from({ ...defaultScript("XUDT"), args: computeScriptHash(ickbLogicScript()) + "80000000" });
}

export function ickbLogicScript() {
    return defaultScript("ICKB_LOGIC");
}

export function ownedOwnerScript() {
    return defaultScript("OWNED_OWNER");
}

export const ICKB_SOFT_CAP_PER_DEPOSIT = 100000n * ckbInShannons;
export function ickbDepositValue(ckbUnoccupiedCapacity: bigint, header: I8Header) {
    let ickbAmount = ckb2Ickb(ckbUnoccupiedCapacity, header, false);
    if (ICKB_SOFT_CAP_PER_DEPOSIT < ickbAmount) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickbAmount -= (ickbAmount - ICKB_SOFT_CAP_PER_DEPOSIT) / 10n;
    }

    return ickbAmount;
}

export function ickbReceiptValue(receiptCount: number, receiptAmount: bigint, header: I8Header) {
    return ickbDepositValue(receiptAmount, header) * BigInt(receiptCount);
}

export function ckbSoftCapPerDeposit(header: I8Header) {
    return ickb2Ckb(ICKB_SOFT_CAP_PER_DEPOSIT, header);
}

export function ckb2Ickb(ckbAmount: bigint, header: I8Header, accountDepositCapacity = true) {
    const { ckbMultiplier, udtMultiplier } = ickbExchangeRatio(header, accountDepositCapacity);
    return ckbAmount * ckbMultiplier / udtMultiplier;
}

export function ickb2Ckb(udtAmount: bigint, header: I8Header, accountDepositCapacity = true) {
    const { ckbMultiplier, udtMultiplier } = ickbExchangeRatio(header, accountDepositCapacity);
    return udtAmount * udtMultiplier / ckbMultiplier;
}

const AR_0 = 10000000000000000n;
const depositCapacityMultiplier = 82n * ckbInShannons * AR_0 / ICKB_SOFT_CAP_PER_DEPOSIT;
export function ickbExchangeRatio(header: I8Header, accountDepositCapacity = true) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"].toBigInt();
    return {
        ckbMultiplier: AR_0,
        udtMultiplier: accountDepositCapacity ? AR_m + depositCapacityMultiplier : AR_m
    }
}