import type { Cell, OutPoint } from "@ckb-lumos/base";
import { parseEpoch, type EpochSinceValue } from "@ckb-lumos/base/lib/since.js";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils.js";
import { hexify } from "@ckb-lumos/codec/lib/bytes.js";
import { extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao.js";
import type { TransactionSkeletonType } from "@ckb-lumos/helpers";
import {
  I8Cell,
  I8Header,
  I8Script,
  addCells,
  CKB,
  daoDeposit,
  daoRequestWithdrawalFrom,
  daoSifter,
  daoWithdrawFrom,
  errorUndefinedBlockNumber,
  headerDeps,
  isDaoDeposit,
  scriptEq,
  typeSifter,
  isDaoWithdrawalRequest,
  lockExpanderFrom,
  hex,
  Uint128,
  type ConfigAdapter,
} from "@ickb/lumos-utils";
import { OwnedOwnerData, ReceiptData, UdtData } from "./encoding.js";
import { epochSinceAdd } from "@ickb/lumos-utils";
import { withdrawalEpochEstimation } from "@ickb/lumos-utils";
import { epochSinceCompare } from "@ickb/lumos-utils";

export type WithdrawalRequestGroup = {
  ownedWithdrawalRequest: I8Cell;
  owner: I8Cell;
};

export function ickbSifter(
  inputs: readonly Cell[],
  accountLockExpander: (c: Cell) => I8Script | undefined,
  getHeader: (blockNumber: string, context: Cell) => I8Header,
  config: ConfigAdapter,
) {
  const ickbUdt = ickbUdtType(config);
  const ickbLogic = ickbLogicScript(config);

  const udts: I8Cell[] = [];
  const receipts: I8Cell[] = [];
  let withdrawalRequests: I8Cell[] = [];
  let ickbPool: I8Cell[] = [];
  let unknowns: Cell[] = [];
  for (const c of inputs) {
    const accountLock = accountLockExpander(c);
    if (!accountLock) {
      unknowns.push(c);
      continue;
    }
    if (scriptEq(c.cellOutput.type, ickbUdt)) {
      udts.push(
        I8Cell.from({
          ...c,
          cellOutput: {
            lock: accountLock,
            type: ickbUdt,
            capacity: c.cellOutput.capacity,
          },
        }),
      );
      continue;
    }
    if (!scriptEq(c.cellOutput.type, ickbLogic)) {
      unknowns.push(c);
      continue;
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
            [headerDeps]: [getHeader(c.blockNumber, c)],
          }),
          capacity: c.cellOutput.capacity,
        },
      }),
    );
  }

  let unknowns_: I8Cell[];
  ({
    deposits: ickbPool,
    withdrawalRequests: unknowns_,
    notDaos: unknowns,
  } = daoSifter(unknowns, lockExpanderFrom(ickbLogic), getHeader, config));
  unknowns = unknowns.concat(unknowns_);

  const ownedOwner = ownedOwnerScript(config);
  ({
    deposits: unknowns_,
    withdrawalRequests,
    notDaos: unknowns,
  } = daoSifter(unknowns, lockExpanderFrom(ownedOwner), getHeader, config));
  unknowns = unknowns.concat(unknowns_);

  let owners: I8Cell[];
  ({ types: owners, notTypes: unknowns } = typeSifter(
    unknowns,
    ownedOwner,
    accountLockExpander,
  ));

  const key = (o: OutPoint) => o.txHash + o.index;
  const outPoint2withdrawalRequests = new Map(
    withdrawalRequests.map((c) => [key(c.outPoint!), c]),
  );
  const withdrawalRequestGroups: WithdrawalRequestGroup[] = [];
  for (const owner of owners) {
    const { ownedDistance } = OwnedOwnerData.unpack(owner.data);
    const index = hex(Number(owner.outPoint!.index) + ownedDistance);
    const k = key({ ...owner.outPoint!, index });
    const ownedWithdrawalRequest = outPoint2withdrawalRequests.get(k);

    if (ownedWithdrawalRequest) {
      withdrawalRequestGroups.push(
        Object.freeze({ owner, ownedWithdrawalRequest }),
      );
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
    ickbPool,
    notIckbs: unknowns,
  };
}

export type ExtendedDeposit = {
  deposit: I8Cell;
  ickbValue: bigint;
  estimatedMaturity: EpochSinceValue;
};

export function ickbPoolSifter(
  ickbPool: readonly I8Cell[],
  tipHeader: I8Header,
  minLocking?: EpochSinceValue,
  additionalMaxLocking?: EpochSinceValue,
): Readonly<ExtendedDeposit>[] {
  let extendedDeposits = ickbPool.map((d) =>
    Object.freeze({
      deposit: d,
      ickbValue: ickbValue(
        BigInt(d.cellOutput.capacity) - depositUsedCapacity,
        d.cellOutput.type![headerDeps][0],
      ),
      estimatedMaturity: { length: 1, index: 0, number: 0 },
    }),
  );

  if (minLocking) {
    //Let's fast forward the tip header of minLockingPeriod to avoid withdrawals having to wait 180 more epochs
    const withdrawalRequestEpoch = epochSinceAdd(
      parseEpoch(tipHeader.epoch),
      minLocking,
    );
    extendedDeposits = extendedDeposits
      .map((e) =>
        Object.freeze({
          ...e,
          estimatedMaturity: withdrawalEpochEstimation(
            e.deposit,
            withdrawalRequestEpoch,
          ),
        }),
      )
      .sort((a, b) =>
        epochSinceCompare(a.estimatedMaturity, b.estimatedMaturity),
      );

    if (additionalMaxLocking) {
      const maxWithdrawalEpoch = epochSinceAdd(
        withdrawalRequestEpoch,
        additionalMaxLocking,
      );
      extendedDeposits = extendedDeposits.filter(
        (d) => epochSinceCompare(d.estimatedMaturity, maxWithdrawalEpoch) <= 0,
      );
    }
  }

  return extendedDeposits;
}

export function ickbDeposit(
  tx: TransactionSkeletonType,
  depositQuantity: number,
  depositAmount: bigint,
  config: ConfigAdapter,
) {
  return daoDeposit(
    tx,
    Array(depositQuantity).fill(depositAmount),
    ickbLogicScript(config),
    config,
  );
}

export function ickbRequestWithdrawalFrom(
  tx: TransactionSkeletonType,
  deposits: readonly I8Cell[],
  config: ConfigAdapter,
) {
  return daoRequestWithdrawalFrom(tx, deposits, ownedOwnerScript(config));
}

export function addWithdrawalRequestGroups(
  tx: TransactionSkeletonType,
  withdrawalRequestGroups: readonly WithdrawalRequestGroup[],
) {
  const withdrawalRequests: I8Cell[] = [];
  const owners: I8Cell[] = [];
  for (const { ownedWithdrawalRequest, owner } of withdrawalRequestGroups) {
    withdrawalRequests.push(ownedWithdrawalRequest);
    owners.push(owner);
  }

  if (withdrawalRequests.length > 0) {
    tx = daoWithdrawFrom(tx, withdrawalRequests);
    tx = addCells(tx, "append", owners, []);
  }

  return tx;
}

export function ickbDelta(tx: TransactionSkeletonType, config: ConfigAdapter) {
  const ickbUdt = ickbUdtType(config);
  const ickbLogic = ickbLogicScript(config);
  let ickbDelta = 0n;
  for (const c of tx.inputs) {
    //iCKB token
    if (scriptEq(c.cellOutput.type, ickbUdt)) {
      ickbDelta += Uint128.unpack(c.data.slice(0, 2 + 16 * 2));
      continue;
    }

    //Withdrawal from iCKB pool of NervosDAO deposits
    if (scriptEq(c.cellOutput.lock, ickbLogic) && isDaoDeposit(c, config)) {
      const header = (c as I8Cell).cellOutput.type![headerDeps][0];
      const ckbUnoccupiedCapacity =
        BigInt(c.cellOutput.capacity) - depositUsedCapacity;
      ickbDelta -= ickbValue(ckbUnoccupiedCapacity, header);
      continue;
    }

    //iCKB Receipt
    if (scriptEq(c.cellOutput.type, ickbLogic)) {
      const header = (c as I8Cell).cellOutput.type![headerDeps][0];
      const { depositQuantity: quantity, depositAmount: amount } =
        ReceiptData.unpack(c.data).value;
      ickbDelta += ickbValue(amount, header) * BigInt(quantity);
    }
  }

  for (const c of tx.outputs) {
    //iCKB token
    if (scriptEq(c.cellOutput.type, ickbUdt)) {
      ickbDelta -= Uint128.unpack(c.data.slice(0, 2 + 16 * 2));
    }
  }

  return ickbDelta;
}

function ickbValue(ckbUnoccupiedCapacity: bigint, header: I8Header) {
  let ickbAmount = ckb2Ickb(ckbUnoccupiedCapacity, header, false);
  if (ICKB_SOFT_CAP_PER_DEPOSIT < ickbAmount) {
    // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
    ickbAmount -= (ickbAmount - ICKB_SOFT_CAP_PER_DEPOSIT) / 10n;
  }

  return ickbAmount;
}

//Handler of iCKB UDT change cells
export function addIckbUdtChange(
  tx: TransactionSkeletonType,
  accountLock: I8Script,
  config: ConfigAdapter,
) {
  const delta = ickbDelta(tx, config);
  if (delta > 0n) {
    const c = I8Cell.from({
      lock: accountLock,
      type: ickbUdtType(config),
      data: hexify(UdtData.pack({ udtAmount: delta })),
    });
    tx = addCells(tx, "append", [], [c]);
  }

  // If delta < 0n, it's a safe invalid transaction, it must be checked with sign of freeIckbUdt.

  return {
    tx,
    freeIckbUdt: delta,
  };
}

//Handler of Owned iCKB Withdrawal Requests for which need to be created an Owner cell
export function addOwnedWithdrawalRequestsChange(
  tx: TransactionSkeletonType,
  accountLock: I8Script,
  config: ConfigAdapter,
) {
  const cc: I8Cell[] = [];
  const ownedOwner = ownedOwnerScript(config);
  for (const [index, c] of tx.outputs.entries()) {
    if (
      !isDaoWithdrawalRequest(c, config) ||
      !scriptEq(c.cellOutput.lock, ownedOwner)
    ) {
      continue;
    }
    const ownerIndex = tx.outputs.size + cc.length;
    const ownedDistance = index - ownerIndex;
    cc.push(
      I8Cell.from({
        lock: accountLock,
        type: ownedOwner,
        data: hexify(OwnedOwnerData.pack({ ownedDistance })),
      }),
    );
  }
  return cc.length > 0 ? addCells(tx, "append", [], cc) : tx;
}

//Handler of receipts for iCKB Deposits
export function addReceiptDepositsChange(
  tx: TransactionSkeletonType,
  accountLock: I8Script,
  config: ConfigAdapter,
) {
  const ickbLogic = ickbLogicScript(config);
  const depositAmount2Quantity = new Map<
    bigint,
    ReturnType<typeof ReceiptData.unpack>
  >();
  for (const c of tx.outputs) {
    if (!isDaoDeposit(c, config) || !scriptEq(c.cellOutput.lock, ickbLogic)) {
      continue;
    }

    const depositAmount = BigInt(c.cellOutput.capacity) - depositUsedCapacity;
    let v = depositAmount2Quantity.get(depositAmount);
    if (v) {
      v.value.depositQuantity += 1;
    } else {
      depositAmount2Quantity.set(depositAmount, {
        type: "ReceiptDataV0",
        value: {
          depositQuantity: 1,
          depositAmount,
        },
      });
    }
  }

  const cc: I8Cell[] = [];
  for (const d of depositAmount2Quantity.values()) {
    cc.push(
      I8Cell.from({
        lock: accountLock,
        type: ickbLogic,
        data: hexify(ReceiptData.pack(d)),
      }),
    );
  }
  return cc.length > 0 ? addCells(tx, "append", [], cc) : tx;
}

export const ICKB_SOFT_CAP_PER_DEPOSIT = 100000n * CKB;
export function ckbSoftCapPerDeposit(header: I8Header) {
  return ickb2Ckb(ICKB_SOFT_CAP_PER_DEPOSIT, header);
}

export function ckb2Ickb(
  ckbAmount: bigint,
  header: I8Header,
  accountDepositCapacity = true,
) {
  const { ckbMultiplier, udtMultiplier } = ickbExchangeRatio(
    header,
    accountDepositCapacity,
  );
  return (ckbAmount * ckbMultiplier) / udtMultiplier;
}

export function ickb2Ckb(
  udtAmount: bigint,
  header: I8Header,
  accountDepositCapacity = true,
) {
  const { ckbMultiplier, udtMultiplier } = ickbExchangeRatio(
    header,
    accountDepositCapacity,
  );
  return (udtAmount * udtMultiplier) / ckbMultiplier;
}

const AR_0 = 10000000000000000n;
const depositUsedCapacity = 82n * CKB;
const depositCapacityMultiplier =
  (depositUsedCapacity * AR_0) / ICKB_SOFT_CAP_PER_DEPOSIT;
export function ickbExchangeRatio(
  header: I8Header,
  accountDepositCapacity = true,
) {
  const daoData = extractDaoDataCompatible(header.dao);
  const AR_m = daoData["ar"].toBigInt();
  return {
    ckbMultiplier: AR_0,
    udtMultiplier: accountDepositCapacity
      ? AR_m + depositCapacityMultiplier
      : AR_m,
  };
}

export function ickbUdtType(config: ConfigAdapter) {
  return I8Script.from({
    ...config.defaultScript("XUDT"),
    args: computeScriptHash(ickbLogicScript(config)) + "00000080",
  });
}

export function ickbLogicScript(config: ConfigAdapter) {
  return config.defaultScript("ICKB_LOGIC");
}

export function ownedOwnerScript(config: ConfigAdapter) {
  return config.defaultScript("OWNED_OWNER");
}
