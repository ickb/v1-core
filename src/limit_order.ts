import { hexify } from "@ckb-lumos/codec/lib/bytes.js";
import type { TransactionSkeletonType } from "@ckb-lumos/helpers";
import type { Cell, OutPoint } from "@ckb-lumos/base";
import {
  I8Cell,
  I8Script,
  addCells,
  I8OutPoint,
  hex,
  type ConfigAdapter,
  i8ScriptPadding,
  scriptEq,
  CKB,
} from "@ickb/lumos-utils";
import { ickbUdtType } from "./ickb_logic.js";
import { OrderData } from "./codec.js";
import type { UnpackedOrder } from "./codec.js";

export type MyOrder = Order & {
  master: I8Cell;
};

export type Order = {
  cell: I8Cell;
  info: Required<BaseOrderInfo> & {
    isMint: boolean;
    masterOutpoint: Readonly<I8OutPoint>;
    // Computed properties
    ckbOccupied: bigint;
    ckbUnoccupied: bigint;
    isCkb2Udt: boolean; // It can also be dual ratio
    isUdt2Ckb: boolean; // It can also be dual ratio
    isDualRatio: boolean;
    ckbMinMatch: bigint;
    isCkb2UdtMatchable: boolean;
    isUdt2CkbMatchable: boolean;
    isMatchable: boolean;
    // A competition progress, relProgress= 100*Number(absProgress)/Number(absTotal)
    absProgress: bigint;
    absTotal: bigint;
  };
};

export type BaseOrderInfo = {
  ckbToUdt: OrderRatio;
  udtToCkb: OrderRatio;
  ckbMinMatchLog: number;
  udtAmount?: bigint;
  ckbAmount?: bigint;
};

export type OrderRatio = {
  ckbMultiplier: bigint;
  udtMultiplier: bigint;
};

function ratioEq(r0: OrderRatio, r1: OrderRatio) {
  return (
    r0.ckbMultiplier === r1.ckbMultiplier &&
    r0.udtMultiplier === r1.udtMultiplier
  );
}

function OrderInfoEq(i0: BaseOrderInfo, i1: BaseOrderInfo) {
  return (
    ratioEq(i0.ckbToUdt, i1.ckbToUdt) &&
    ratioEq(i0.udtToCkb, i1.udtToCkb) &&
    i0.ckbMinMatchLog === i1.ckbMinMatchLog
  );
}

export function orderSifter(
  inputs: readonly Cell[],
  accountLockExpander: (c: Cell) => I8Script | undefined,
  getTxOutputs: (txHash: string) => Readonly<Cell[]>,
  config: ConfigAdapter,
  udtType = ickbUdtType(config),
) {
  const orderScript = limitOrderScript(config);

  // Sift and group matching orders and master cells of udtType
  const { groups, unknowns } = rawSifter(
    inputs,
    accountLockExpander,
    orderScript,
    udtType,
  );

  // Fetch the original mint transactions of the orders found
  const mints = mintsOf(
    [...groups.values()].map(
      (g) => g.master?.outPoint ?? g.orders[0].info.masterOutpoint,
    ),
    getTxOutputs,
    orderScript,
    udtType,
  );

  // Validate that orders are in line with the mints and not forged
  const orders: Order[] = [];
  const myOrders: MyOrder[] = [];
  for (const [k, group] of groups) {
    const mint = mints.get(k);
    if (mint === undefined) {
      // No mint group found, all orders in this group are forged, so discard them
      const m = group.master === undefined ? [] : [group.master];
      unknowns.push(...m, ...group.orders.map((o) => o.cell));
      continue;
    }

    // Find the order that has the best value, while keeping the mint parameters
    let iBest = -1;
    let best: Order = mint;
    for (let i = 0; i < group.orders.length; i++) {
      const o = group.orders[i];

      // Check that parameters are the the mint parameters
      if (
        !OrderInfoEq(mint.info, o.info) ||
        !scriptEq(mint.cell.cellOutput.type, o.cell.cellOutput.type) ||
        o.info.absTotal < mint.info.absTotal
      ) {
        // Discard current forged order
        unknowns.push(o.cell);
        continue;
      }

      // Pick order with best absProgress
      if (o.info.absProgress < best.info.absProgress) {
        // Discard current forged order
        unknowns.push(o.cell);
        continue;
      }

      // At equality of absProgress, give preference to newly minted orders
      if (o.info.absProgress === best.info.absProgress && !o.info.isMint) {
        // Discard current forged order
        unknowns.push(o.cell);
        continue;
      }

      // Discard the old Best order
      if (iBest >= 0) {
        unknowns.push(best.cell);
      }

      iBest = i;
      best = o;
    }

    // Discard master cell if group doesn't contain a valid match
    if (iBest === -1) {
      if (group.master !== undefined) {
        unknowns.push(group.master);
      }
      continue;
    }

    // Add the current best order and maybe master to the results
    if (group.master !== undefined) {
      // Order owned by Account
      myOrders.push(
        Object.freeze({
          ...best,
          master: group.master,
        }),
      );
    } else {
      // Order not owned by Account
      orders.push(Object.freeze(best));
    }
  }

  return {
    myOrders,
    orders,
    notOrders: unknowns,
  };
}

function mintsOf(
  masterOutpoints: readonly I8OutPoint[],
  getTxOutputs: (txHash: string) => Readonly<Cell[]>,
  orderScript: I8Script,
  udtType: I8Script,
) {
  const mints = new Map<string, MyOrder>();
  const dummyAccountLockExpander = (c: Cell) =>
    I8Script.from({ ...i8ScriptPadding, ...c.cellOutput.lock });
  for (const txHash of new Set(masterOutpoints.map((v) => v.txHash))) {
    // Fetch the original mint transactions of the masterOutpoints
    for (const [k, g] of rawSifter(
      getTxOutputs(txHash),
      dummyAccountLockExpander,
      orderScript,
      udtType,
    ).groups) {
      // Keep only valid mint transactions
      if (
        g.master === undefined ||
        g.orders.length !== 1 ||
        !g.orders[0].info.isMint
      ) {
        continue;
      }

      mints.set(k, {
        ...g.orders[0],
        master: g.master,
      });
    }
  }

  return mints;
}

function rawSifter(
  inputs: readonly Cell[],
  accountLockExpander: (c: Cell) => I8Script | undefined,
  orderScript: I8Script,
  udtType: I8Script,
) {
  const groups = new Map<
    string,
    {
      master: I8Cell | undefined;
      orders: Order[];
    }
  >();

  // Utility for creating and/or getting group entries of the groups map
  const groupOf = (o: OutPoint) => {
    const key = o.txHash + o.index;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        master: undefined,
        orders: [],
      };
      groups.set(key, group);
    }
    return group;
  };

  const unknowns: Cell[] = [];
  for (const c of inputs) {
    const { lock, type } = c.cellOutput;
    if (scriptEq(type, orderScript)) {
      // Master cell
      const lock = accountLockExpander(c);
      if (lock) {
        groupOf(c.outPoint!).master = I8Cell.from({
          ...c,
          cellOutput: {
            lock,
            type: orderScript,
            capacity: c.cellOutput.capacity,
          },
        });
        continue;
      }
    } else if (scriptEq(lock, orderScript) && scriptEq(type, udtType)) {
      const info = extractOrderInfo(c);
      if (info !== undefined) {
        // Limit Order
        groupOf(info.masterOutpoint).orders.push({
          cell: I8Cell.from({
            ...c,
            cellOutput: {
              lock: orderScript,
              type: udtType,
              capacity: c.cellOutput.capacity,
            },
          }),
          info,
        });
        continue;
      }
    }

    // Discard unknown cell
    unknowns.push(c);
  }

  return { groups, unknowns };
}

function extractOrderInfo(cell: Cell) {
  let o: UnpackedOrder;
  try {
    o = OrderData.unpack(cell.data);
  } catch {
    return;
  }

  const orderInfo = o.value.orderInfo;
  const ckbToUdt = normalizeRatio(orderInfo.ckbToUdt);
  const udtToCkb = normalizeRatio(orderInfo.udtToCkb);
  const ckbMinMatchLog = normalizeCkbMinMatchLog(orderInfo.ckbMinMatchLog);

  // Check that the order is valid
  if (
    !OrderInfoEq({ ckbToUdt, udtToCkb, ckbMinMatchLog }, orderInfo) ||
    (o.type === "MintOrderData" && o.value.padding !== padding) ||
    cell.cellOutput.type === undefined ||
    cell.cellOutput.type.args.length < 2 // args must at least contain "0x"
  ) {
    return;
  }

  const isMint = o.type === "MintOrderData";

  const masterOutpoint = I8OutPoint.from(
    o.type === "MintOrderData"
      ? {
          txHash: cell.outPoint!.txHash,
          index: hex(Number(cell.outPoint!.index) + o.value.masterDistance),
        }
      : o.value.masterOutpoint,
  );

  const ckbMinMatch = 1n << BigInt(ckbMinMatchLog);
  const udtAmount = o.udtAmount;
  const ckbAmount = BigInt(cell.cellOutput.capacity);
  const ckbOccupied =
    orderMinCkb + BigInt((cell.cellOutput.type.args.length - 2) / 2) * CKB;
  const ckbUnoccupied = ckbAmount - ckbOccupied;

  const isCkb2Udt = ckbToUdt !== zeroRatio;
  const isUdt2Ckb = udtToCkb !== zeroRatio;
  const isDualRatio = isCkb2Udt && isUdt2Ckb;

  const ckb2UdtValue = isCkb2Udt
    ? ckbUnoccupied * ckbToUdt.ckbMultiplier +
      udtAmount * ckbToUdt.udtMultiplier
    : 0n;

  const udt2CkbValue = isUdt2Ckb
    ? ckbUnoccupied * udtToCkb.ckbMultiplier +
      udtAmount * udtToCkb.udtMultiplier
    : 0n;

  const absTotal =
    ckb2UdtValue === 0n
      ? udt2CkbValue
      : udt2CkbValue === 0n
        ? ckb2UdtValue
        : // Take the average of the two values for dual ratio orders
          (ckb2UdtValue * udtToCkb.ckbMultiplier * udtToCkb.udtMultiplier +
            udt2CkbValue * ckbToUdt.ckbMultiplier * ckbToUdt.udtMultiplier) >>
          1n;

  const absProgress = isDualRatio
    ? absTotal
    : isCkb2Udt
      ? udtAmount * ckbToUdt.udtMultiplier
      : ckbUnoccupied * udtToCkb.ckbMultiplier;

  const isCkb2UdtMatchable = isCkb2Udt && ckbUnoccupied > 0n;
  const isUdt2CkbMatchable = isUdt2Ckb && udtAmount > 0n;
  const isMatchable = isCkb2UdtMatchable || isUdt2CkbMatchable;

  return Object.freeze({
    isMint,
    masterOutpoint,
    ckbToUdt,
    udtToCkb,
    ckbMinMatchLog,
    ckbMinMatch,
    udtAmount,
    ckbAmount,
    ckbOccupied,
    ckbUnoccupied,
    absTotal,
    absProgress,
    isCkb2Udt,
    isUdt2Ckb,
    isDualRatio,
    isCkb2UdtMatchable,
    isUdt2CkbMatchable,
    isMatchable,
  });
}

export const defaultCkbMinMatchLog = 33; // ~ 86 CKB

export function orderMint(
  tx: TransactionSkeletonType,
  ...info: Parameters<typeof orderFrom>
) {
  const { master, order } = orderFrom(...info);
  return addCells(tx, "append", [], [master, order]);
}

export const errorInvalidRatio = "Order ratio are invalid";
export function orderFrom(
  accountLock: I8Script,
  config: ConfigAdapter,
  ckbAmount = 0n, //it will use way more CKB than expressed in ckbAmount
  udtAmount = 0n,
  ckbToUdt = zeroRatio,
  udtToCkb = zeroRatio,
  ckbMinMatchLog = defaultCkbMinMatchLog,
  udtType = ickbUdtType(config),
) {
  ckbToUdt = normalizeRatio(ckbToUdt);
  udtToCkb = normalizeRatio(udtToCkb);
  ckbMinMatchLog = normalizeCkbMinMatchLog(ckbMinMatchLog);
  if (ckbToUdt === zeroRatio && udtToCkb === zeroRatio) {
    throw Error(errorInvalidRatio);
  }

  // Check that if we convert from ckb to udt and then back from udt to ckb, it doesn't lose value.
  if (
    ckbToUdt.ckbMultiplier * udtToCkb.udtMultiplier <
    ckbToUdt.udtMultiplier * udtToCkb.ckbMultiplier
  ) {
    throw Error(errorInvalidRatio);
  }

  const orderScript = limitOrderScript(config);
  const master = I8Cell.from({
    lock: accountLock,
    type: orderScript,
  });

  let order = I8Cell.from({
    lock: orderScript,
    type: udtType,
    data: hexify(
      OrderData.pack({
        udtAmount: udtAmount,
        type: "MintOrderData",
        value: {
          padding,
          masterDistance: -1,
          orderInfo: {
            ckbToUdt,
            udtToCkb,
            ckbMinMatchLog,
          },
        },
      }),
    ),
  });

  if (ckbAmount > 0n) {
    order = I8Cell.from({
      ...order,
      capacity: hex(BigInt(order.cellOutput.capacity) + ckbAmount),
    });
  }

  return { master, order };
}

export function orderMatch(
  tx: TransactionSkeletonType,
  o: Order,
  isCkb2Udt: boolean,
  ckbAllowance: bigint | undefined,
  udtAllowance: bigint | undefined,
) {
  const { match } = orderSatisfy(o, isCkb2Udt, ckbAllowance, udtAllowance);
  return addCells(tx, "append", [o.cell], [match]);
}

export const errorOrderNonMatchable =
  "The order cannot be matched in the specified direction";
export const errorAllowanceTooLow =
  "Not enough allowance to partially fulfill the limit order";
export function orderSatisfy(
  o: Order,
  isCkb2Udt: boolean,
  ckbAllowance: bigint = 1n << 64n,
  udtAllowance: bigint = 1n << 128n,
) {
  let ckbMultiplier: bigint, udtMultiplier: bigint;
  if (isCkb2Udt) {
    if (!o.info.isCkb2UdtMatchable) {
      throw Error(errorOrderNonMatchable);
    }
    ({ ckbMultiplier, udtMultiplier } = o.info.ckbToUdt);
  } else {
    if (!o.info.isUdt2CkbMatchable) {
      throw Error(errorOrderNonMatchable);
    }
    ({ ckbMultiplier, udtMultiplier } = o.info.udtToCkb);
  }
  let { ckbAmount: ckbIn, udtAmount: udtIn, ckbMinMatch } = o.info;

  const result = (ckbOut: bigint, udtOut: bigint, isFulfilled: boolean) => {
    let match = I8Cell.from({
      ...o.cell.cellOutput,
      capacity: hex(ckbOut),
      data: hexify(
        OrderData.pack({
          udtAmount: udtOut,
          type: "MatchOrderData",
          value: {
            masterOutpoint: o.info.masterOutpoint,
            orderInfo: o.info,
          },
        }),
      ),
    });
    return { match, isFulfilled };
  };

  // Try to fulfill the order completely;
  let isFulfilled = true;
  if (isCkb2Udt) {
    let ckbOut = BigInt(result(0n, 0n, isFulfilled).match.cellOutput.capacity);
    let udtOut = calculate(ckbMultiplier, udtMultiplier, ckbIn, udtIn, ckbOut);
    if (udtIn + udtAllowance >= udtOut) {
      return result(ckbOut, udtOut, isFulfilled);
    }
  } else {
    let udtOut = 0n;
    let ckbOut = calculate(udtMultiplier, ckbMultiplier, udtIn, ckbIn, udtOut);
    if (ckbIn + ckbAllowance >= ckbOut) {
      return result(ckbOut, udtOut, isFulfilled);
    }
  }

  // Allowance limits the order fulfillment
  isFulfilled = false;
  if (isCkb2Udt) {
    let udtOut = udtIn + udtAllowance;
    let ckbOut = calculate(udtMultiplier, ckbMultiplier, udtIn, ckbIn, udtOut);
    // DOS prevention: ckbMinMatch is the minimum partial match.
    if (ckbIn < ckbOut + ckbMinMatch) {
      throw Error(errorAllowanceTooLow);
    }
    return result(ckbOut, udtOut, isFulfilled);
  } else {
    let ckbOut = ckbIn + ckbAllowance;
    let udtOut = calculate(ckbMultiplier, udtMultiplier, ckbIn, udtIn, ckbOut);
    // DoS prevention: the equivalent of ckbMinMatch is the minimum partial match.
    if (
      udtIn * udtMultiplier <
      udtOut * udtMultiplier + ckbMinMatch * ckbMultiplier
    ) {
      throw Error(errorAllowanceTooLow);
    }
    return result(ckbOut, udtOut, isFulfilled);
  }
}

// Limit order rule on non decreasing value:
// min bOut such that aM * aIn + bM * bIn <= aM * aOut + bM * bOut
// bOut = (aM * (aIn - aOut) + bM * bIn) / bM
// But integer divisions truncate, so we need to round to the upper value
// bOut = (aM * (aIn - aOut) + bM * bIn + bM - 1) / bM
// bOut = (aM * (aIn - aOut) + bM * (bIn + 1) - 1) / bM
function calculate(
  aM: bigint,
  bM: bigint,
  aIn: bigint,
  bIn: bigint,
  aOut: bigint,
) {
  return (aM * (aIn - aOut) + bM * (bIn + 1n) - 1n) / bM;
}

export function orderMelt(tx: TransactionSkeletonType, oo: MyOrder[]) {
  return addCells(
    tx,
    "append",
    oo.flatMap((o) => [o.cell, o.master]),
    [],
  );
}

export function ckb2UdtRatioCompare(r0: OrderRatio, r1: OrderRatio): number {
  return udt2CkbRatioCompare(r1, r0);
}

export function udt2CkbRatioCompare(r0: OrderRatio, r1: OrderRatio): number {
  if (r0.ckbMultiplier == r1.ckbMultiplier) {
    return Number(r0.udtMultiplier - r1.udtMultiplier);
  }

  if (r0.udtMultiplier == r1.udtMultiplier) {
    return Number(r1.ckbMultiplier - r0.ckbMultiplier);
  }

  // Idea: o0.Udt2CkbRatio - o1.Udt2CkbRatio
  // ~ o0.udtMultiplier / o0.ckbMultiplier - o1.udtMultiplier / o1.ckbMultiplier
  // order equivalent to:
  // ~ o0.udtMultiplier * o1.ckbMultiplier - o1.udtMultiplier * o0.ckbMultiplier
  return Number(
    r0.udtMultiplier * r1.ckbMultiplier - r1.udtMultiplier * r0.ckbMultiplier,
  );
}

export function limitOrderScript(config: ConfigAdapter) {
  return config.defaultScript("LIMIT_ORDER");
}

function normalizeCkbMinMatchLog(n: number) {
  return n > 64 ? 64 : n;
}

function normalizeRatio(r: OrderRatio): OrderRatio {
  if (r.ckbMultiplier === 0n || r!.udtMultiplier === 0n) {
    return zeroRatio;
  } else {
    return Object.freeze({ ...r });
  }
}

const zeroRatio: OrderRatio = Object.freeze({
  ckbMultiplier: 0n,
  udtMultiplier: 0n,
});

const padding =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const orderMinCkb = BigInt(
  I8Cell.from({
    lock: i8ScriptPadding,
    type: i8ScriptPadding,
    data: hexify(
      OrderData.pack({
        udtAmount: 0n,
        type: "MintOrderData",
        value: {
          masterDistance: 0,
          padding,
          orderInfo: {
            ckbToUdt: zeroRatio,
            udtToCkb: zeroRatio,
            ckbMinMatchLog: 0,
          },
        },
      }),
    ),
  }).cellOutput.capacity,
);
