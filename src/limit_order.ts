import { hexify } from "@ckb-lumos/codec/lib/bytes.js";
import type { TransactionSkeletonType } from "@ckb-lumos/helpers";
import type { Cell, OutPoint } from "@ckb-lumos/base";
import {
  I8Cell,
  I8Script,
  addCells,
  typeSifter,
  lockExpanderFrom,
  I8OutPoint,
  hex,
  type ConfigAdapter,
} from "@ickb/lumos-utils";
import { ickbUdtType } from "./ickb_logic.js";
import { OrderData } from "./codec.js";
import type { UnpackedOrder } from "./codec.js";

export type MyOrder = Order & {
  master: I8Cell;
};

export type Order = {
  cell: I8Cell;
  master: { outPoint: I8OutPoint };
  info: Required<BaseOrderInfo> & {
    // Computed properties
    ckbMinMatch: bigint;
    isCkb2UdtMatchable: boolean;
    isUdt2CkbMatchable: boolean;
    isMatchable: boolean;
    isDualRatio: boolean;
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

const padding =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export function orderSifter(
  inputs: readonly Cell[],
  accountLockExpander: (c: Cell) => I8Script | undefined,
  config: ConfigAdapter,
  udtType = ickbUdtType(config),
) {
  const orderScript = limitOrderScript(config);
  let { types, notTypes: unknowns } = typeSifter(
    inputs,
    udtType,
    lockExpanderFrom(orderScript),
  );
  let masters: I8Cell[] = [];
  ({ types: masters, notTypes: unknowns } = typeSifter(
    unknowns,
    orderScript,
    accountLockExpander,
  ));
  const key = (o: OutPoint) => o.txHash + o.index;
  const outPoint2Master = new Map(
    masters.map((c) => [key(c.outPoint!), c as MyOrder["master"]]),
  );

  const ckbOccupiedMax = ckbOrderOccupiedMax(orderScript, udtType);

  const orders: Order[] = [];
  const myOrders: MyOrder[] = [];
  for (const cell of types) {
    let o: UnpackedOrder;
    try {
      o = OrderData.unpack(cell.data);
    } catch (e: unknown) {
      unknowns.push(cell);
      continue;
    }

    const {
      ckbToUdt: c2u,
      udtToCkb: u2c,
      ckbMinMatchLog: cmml,
    } = o.value.orderInfo;
    const ckbToUdt = normalizeRatio(c2u);
    const udtToCkb = normalizeRatio(u2c);
    const ckbMinMatchLog = normalizeCkbMinMatchLog(cmml);

    // Check that the order is valid
    if (
      ckbToUdt.ckbMultiplier !== c2u.ckbMultiplier ||
      ckbToUdt.udtMultiplier !== c2u.udtMultiplier ||
      udtToCkb.ckbMultiplier !== u2c.ckbMultiplier ||
      udtToCkb.udtMultiplier !== u2c.udtMultiplier ||
      ckbMinMatchLog !== cmml ||
      (o.type === "MintOrderData" && o.value.padding !== padding)
    ) {
      unknowns.push(cell);
      continue;
    }

    const ckbMinMatch = 1n << BigInt(ckbMinMatchLog);
    const udtAmount = o.udtAmount;
    const ckbAmount = BigInt(cell.cellOutput.capacity);
    const ckbUnused = ckbAmount - ckbOccupiedMax;
    const isCkb2UdtMatchable =
      ckbToUdt !== normalizedInvalidRatio && ckbUnused > 0n;
    const isUdt2CkbMatchable =
      udtToCkb !== normalizedInvalidRatio && udtAmount > 0n;
    const isMatchable = isCkb2UdtMatchable || isUdt2CkbMatchable;
    const isDualRatio =
      ckbToUdt !== normalizedInvalidRatio &&
      udtToCkb !== normalizedInvalidRatio;

    let info: Order["info"] = Object.freeze({
      ckbToUdt,
      udtToCkb,
      ckbMinMatchLog,
      ckbMinMatch,
      udtAmount,
      ckbAmount,
      isCkb2UdtMatchable,
      isUdt2CkbMatchable,
      isMatchable,
      isDualRatio,
    });

    const masterOutPoint = I8OutPoint.from(
      o.type === "MintOrderData"
        ? {
            txHash: cell.outPoint!.txHash,
            index: hex(Number(cell.outPoint!.index) + o.value.masterDistance),
          }
        : o.value.masterOutpoint,
    );
    const k = key(masterOutPoint);
    const master = outPoint2Master.get(k);
    if (master) {
      // Order owned by the Account
      outPoint2Master.delete(k);
      myOrders.push(
        Object.freeze({
          cell,
          master,
          info,
        }),
      );
    } else {
      orders.push(
        Object.freeze({
          cell,
          master: Object.freeze({ outPoint: masterOutPoint }),
          info,
        }),
      );
    }
  }

  for (const c of outPoint2Master.values()) {
    unknowns.push(c);
  }

  return {
    myOrders,
    orders,
    notOrders: unknowns,
  };
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
  ckbToUdt = normalizedInvalidRatio,
  udtToCkb = normalizedInvalidRatio,
  ckbMinMatchLog = defaultCkbMinMatchLog,
  udtType = ickbUdtType(config),
) {
  ckbToUdt = normalizeRatio(ckbToUdt);
  udtToCkb = normalizeRatio(udtToCkb);
  ckbMinMatchLog = normalizeCkbMinMatchLog(ckbMinMatchLog);
  if (
    ckbToUdt === normalizedInvalidRatio &&
    udtToCkb === normalizedInvalidRatio
  ) {
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
            masterOutpoint: o.master.outPoint,
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
    return normalizedInvalidRatio;
  } else {
    return Object.freeze({ ...r });
  }
}

const normalizedInvalidRatio: OrderRatio = Object.freeze({
  ckbMultiplier: 0n,
  udtMultiplier: 0n,
});

function ckbOrderOccupiedMax(orderScript: I8Script, udtType: I8Script) {
  return BigInt(
    I8Cell.from({
      lock: orderScript,
      type: udtType,
      data: hexify(
        OrderData.pack({
          udtAmount: 0n,
          type: "MatchOrderData",
          value: {
            masterOutpoint: {
              txHash:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
              index: "0x0",
            },
            orderInfo: {
              ckbToUdt: normalizedInvalidRatio,
              udtToCkb: normalizedInvalidRatio,
              ckbMinMatchLog: 0,
            },
          },
        }),
      ),
    }).cellOutput.capacity,
  );
}
