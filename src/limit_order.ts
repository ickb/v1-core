import { hexify } from "@ckb-lumos/codec/lib/bytes.js";
import { TransactionSkeleton, type TransactionSkeletonType } from "@ckb-lumos/helpers";
import type { Cell, OutPoint } from "@ckb-lumos/base";
import {
    type Assets, I8Cell, I8Script, addAssetsFunds, addCells, defaultScript,
    i8ScriptPadding, typeSifter, lockExpanderFrom, I8OutPoint, logSplit, hex
} from "@ickb/lumos-utils";
import { ickbUdtType } from "./ickb_logic.js";
import { OrderData } from "./codec.js";

export type Order = {
    cell: I8Cell,
    master: { outPoint: I8OutPoint },
};

export type BaseInfo = {
    isUdtToCkb: boolean;
    ckbMultiplier: bigint;
    udtMultiplier: bigint;
    logMinMatch: number;
    udtAmount?: bigint;
    ckbAmount?: bigint;
}

export type Info = Required<BaseInfo> & {
    ckbMinMatch: bigint;
    udtMinMatch: bigint;
};

export type OpenOrder = Order & Info;

export type MyOrder = Order & {
    master: I8Cell,
};

export type MyOpenOrder = OpenOrder & {
    master: I8Cell,
};

export const errorCkbAllowanceTooLow = "Not enough ckb allowance to partially fulfill a limit order";
export const errorUdtAllowanceTooLow = "Not enough UDT allowance to partially fulfill a limit order";
export const errorTerminalLockNotFound = "Not found an input cell with terminal lock in the transaction";
export function limitOrder(udtType: I8Script = i8ScriptPadding) {
    if (udtType == i8ScriptPadding) {
        udtType = ickbUdtType();
    }
    const orderScript = limitOrderScript();

    function create(
        tx: TransactionSkeletonType,
        o: BaseInfo,//it will use way more CKB than expressed in ckbAmount
        accountLock: I8Script,
    ) {
        const m = I8Cell.from({
            lock: accountLock,
            type: orderScript
        });
        let c = I8Cell.from({
            lock: orderScript,
            type: udtType,
            data: hexify(OrderData.pack({
                udtAmount: o.udtAmount ?? 0,
                type: "MintOrderData",
                value: {
                    masterDistance: -1,
                    orderInfo: o,
                }
            }))
        });

        if (o.ckbAmount) {
            c = I8Cell.from({
                ...c,
                capacity: hex(BigInt(c.cellOutput.capacity) + o.ckbAmount),
            });
        }

        return addCells(tx, "append", [], [m, c]);
    }

    function match(
        tx: TransactionSkeletonType,
        o: OpenOrder,
        ckbAllowance: bigint | undefined,
        udtAllowance: bigint | undefined
    ) {
        const { match } = satisfy(o, ckbAllowance, udtAllowance);
        return addCells(tx, "append", [o.cell], [match]);
    }

    function satisfy(
        o: OpenOrder,
        ckbAllowance: bigint = 1n << 64n,
        udtAllowance: bigint = 1n << 128n
    ) {
        let match = I8Cell.from({
            lock: orderScript,
            type: udtType,
            data: hexify(OrderData.pack({
                udtAmount: 0n,
                type: "FulfillOrderData",
                value: {
                    masterOutpoint: o.master.outPoint
                }
            }))
        });

        // Try to fulfill the order completely
        let udtFulfilled: bigint;
        let ckbFulfilled: bigint;
        let isFulfilled = true;
        if (o.isUdtToCkb) {
            udtFulfilled = 0n;
            ckbFulfilled = calculate(o.udtMultiplier, o.ckbMultiplier, o.udtAmount, o.ckbAmount, udtFulfilled);

            if (ckbFulfilled - o.ckbAmount <= ckbAllowance) {
                match = I8Cell.from({
                    ...match,
                    capacity: hex(ckbFulfilled),
                });

                return { match, isFulfilled };
            }
        } else {
            ckbFulfilled = BigInt(match.cellOutput.capacity);
            udtFulfilled = calculate(o.ckbMultiplier, o.udtMultiplier, o.ckbAmount, o.udtAmount, ckbFulfilled);

            if (udtFulfilled - o.udtAmount <= udtAllowance) {
                match = I8Cell.from({
                    ...match,
                    data: hexify(OrderData.pack({
                        udtAmount: udtFulfilled,
                        type: "FulfillOrderData",
                        value: {
                            masterOutpoint: o.master.outPoint
                        }
                    }))
                });

                return { match, isFulfilled };
            }
        }

        // Allowance limits the order fulfillment, so the output cell is a still a limit order
        isFulfilled = false;
        let ckbOut: bigint;
        let udtOut: bigint;
        if (o.isUdtToCkb) {
            // DoS prevention: o.ckbMinMatch CKB is the minimum partial match.
            // Additionally, remaining UDT must be at least o.udtMinMatch.
            if (ckbAllowance < o.ckbMinMatch || o.udtAmount < 2n * o.udtMinMatch) {
                throw Error(errorCkbAllowanceTooLow);
            }
            let ckbOut0 = o.ckbAmount + ckbAllowance;
            let ckbOut1 = ckbFulfilled - o.ckbMinMatch;
            ckbOut = ckbOut0 < ckbOut1 ? ckbOut0 : ckbOut1;
            udtOut = calculate(o.ckbMultiplier, o.udtMultiplier, o.ckbAmount, o.udtAmount, ckbOut);
        } else {
            // DOS prevention: o.udtMinMatch is the minimum partial match.
            // Additionally, remaining CKB must be at least o.ckbMinMatch
            if (udtAllowance < o.udtMinMatch || o.ckbAmount - ckbFulfilled < 2n * o.ckbMinMatch) {
                throw Error(errorUdtAllowanceTooLow);
            }
            let udtOut0 = o.udtAmount + udtAllowance;
            let udtOut1 = udtFulfilled - o.udtMinMatch;
            udtOut = udtOut0 < udtOut1 ? udtOut0 : udtOut1;
            ckbOut = calculate(o.udtMultiplier, o.ckbMultiplier, o.udtAmount, o.ckbAmount, udtOut);
        }

        match = I8Cell.from({
            lock: orderScript,
            type: udtType,
            capacity: hex(ckbOut),
            data: hexify(OrderData.pack({
                udtAmount: udtOut,
                type: "MatchOrderData",
                value: {
                    masterOutpoint: o.master.outPoint,
                    orderInfo: o
                }
            }))
        });
        return { match, isFulfilled };
    }

    function melt(tx: TransactionSkeletonType, ...oo: MyOrder[]) {
        return addCells(tx, "append", oo.flatMap((o) => [o.cell, o.master]), []);
    }

    function sifter(
        inputs: readonly Cell[],
        accountLockExpander: (c: Cell) => I8Script | undefined
    ) {
        let { types: orders, notTypes: unknowns } = typeSifter(inputs, udtType, lockExpanderFrom(orderScript));
        let masters: I8Cell[] = [];
        ({ types: masters, notTypes: unknowns } = typeSifter(unknowns, orderScript, accountLockExpander));
        const key = (o: OutPoint) => o.txHash + o.index;
        const outPoint2Master = new Map(masters.map(c => [key(c.outPoint!), c]));

        const ckb2UdtOrders: OpenOrder[] = [];
        const udt2CkbOrders: OpenOrder[] = [];
        const completedOrders: Order[] = [];
        const myCkb2UdtOrders: MyOpenOrder[] = [];
        const myUdt2CkbOrders: MyOpenOrder[] = [];
        const myCompletedOrders: MyOrder[] = [];
        for (const cell of orders) {
            const o = OrderData.unpack(cell.data);

            let info = undefined;
            if ("orderInfo" in o.value) {
                info = o.value.orderInfo;
                const ckbMinMatch = 1n << BigInt(Math.min(info.logMinMatch, 64));
                const udtMinMatch = (ckbMinMatch * info.ckbMultiplier + info.udtMultiplier - 1n) / info.udtMultiplier;
                const udtAmount = o.udtAmount;
                const ckbAmount = BigInt(cell.cellOutput.capacity);
                info = { ...info, ckbMinMatch, udtMinMatch, udtAmount, ckbAmount };
            }

            const masterOutPoint = I8OutPoint.from(o.type === "MintOrderData" ? {
                txHash: cell.outPoint!.txHash,
                index: hex(Number(cell.outPoint!.index) + o.value.masterDistance)
            } : o.value.masterOutpoint);
            const k = key(masterOutPoint);
            const master = outPoint2Master.get(k) ?? { outPoint: masterOutPoint };
            const order = Object.freeze({
                cell, master, info
            });

            if ("cellOutput" in master) {
                // Order owned by the Account
                outPoint2Master.delete(k);
                if (!info) {
                    myCompletedOrders.push(order as any);
                } else if (info.isUdtToCkb) {
                    myUdt2CkbOrders.push(order as any);
                } else {
                    myCkb2UdtOrders.push(order as any);
                }
            } else {
                if (!info) {
                    completedOrders.push(order as any);
                } else if (info.isUdtToCkb) {
                    udt2CkbOrders.push(order as any);
                } else {
                    ckb2UdtOrders.push(order as any);
                }
            }
        }

        for (const c of outPoint2Master.values()) {
            unknowns.push(c);
        }

        return {
            ckb2UdtOrders,
            udt2CkbOrders,
            completedOrders,
            myCkb2UdtOrders,
            myUdt2CkbOrders,
            myCompletedOrders,
            notOrders: unknowns
        };
    }

    function fundAdapter(
        assets: Assets,
        orders: ReturnType<typeof sifter>
    ): Assets {
        const addFunds: ((tx: TransactionSkeletonType) => TransactionSkeletonType)[] = [];

        for (const oo of logSplit(orders.myCompletedOrders)) {
            addFunds.push((tx: TransactionSkeletonType) => melt(tx, ...oo));
        }

        const unavailableFunds = [
            TransactionSkeleton()
                .update("inputs", i => i.concat(
                    orders.myCkb2UdtOrders.flatMap(c => [c.cell, c.master]),
                    orders.myUdt2CkbOrders.flatMap(c => [c.cell, c.master])
                ))
        ];
        return addAssetsFunds(assets, addFunds, unavailableFunds)
    }

    return { udtType, orderScript, create, match, satisfy, melt, sifter, fundAdapter };
}

// Use example:
// udt2CkbOrders.sort(sort === "asc" ? udt2CkbRatioCompare : (o0, o1) => udt2CkbRatioCompare(o1, o0));
// ckb2UdtOrders.sort(sort === "asc" ? (o0, o1) => udt2CkbRatioCompare(o1, o0) : udt2CkbRatioCompare);
export function udt2CkbRatioCompare(
    o0: { ckbMultiplier: bigint, udtMultiplier: bigint },
    o1: { ckbMultiplier: bigint, udtMultiplier: bigint }
): number {
    if (o0.ckbMultiplier == o1.ckbMultiplier) {
        return Number(o0.udtMultiplier - o1.udtMultiplier);
    }

    if (o0.udtMultiplier == o1.udtMultiplier) {
        return Number(o1.ckbMultiplier - o0.ckbMultiplier);
    }

    // Idea: o0.Udt2CkbRatio - o1.Udt2CkbRatio
    // ~ o0.udtMultiplier / o0.ckbMultiplier - o1.udtMultiplier / o1.ckbMultiplier
    // order equivalent to:
    // ~ o0.udtMultiplier * o1.ckbMultiplier - o1.udtMultiplier * o0.ckbMultiplier 
    return Number(o0.udtMultiplier * o1.ckbMultiplier - o1.udtMultiplier * o0.ckbMultiplier);
}

export function limitOrderScript() {
    return defaultScript("LIMIT_ORDER");
}

// Limit order rule on non decreasing value:
// min bOut such that aM * aIn + bM * bIn <= aM * aOut + bM * bOut
// bOut = (aM * (aIn - aOut) + bM * bIn) / bM
// But integer divisions truncate, so we need to round to the upper value
// bOut = (aM * (aIn - aOut) + bM * bIn + bM - 1) / bM
// bOut = (aM * (aIn - aOut) + bM * (bIn + 1) - 1) / bM
function calculate(aM: bigint, bM: bigint, aIn: bigint, bIn: bigint, aOut: bigint) {
    return (aM * (aIn - aOut) + bM * (bIn + 1n) - 1n) / bM;
}