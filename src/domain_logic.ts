import { Cell, Header, Script } from "@ckb-lumos/base";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { struct } from "@ckb-lumos/codec/lib/molecule";
import { Uint128LE, Uint8 } from "@ckb-lumos/codec/lib/number";
import { extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { minimalCellCapacityCompatible } from "@ckb-lumos/helpers";
import { TransactionBuilder, createUintBICodec, defaultScript, isDAODeposit, scriptEq } from "lumos-utils";

export class IckbTransactionBuilder extends TransactionBuilder {
    override async toChange(ckbDelta: BI, changeCells: Cell[] = []) {
        function changeCellsPush(c: Cell) {
            const minimalCapacity = minimalCellCapacityCompatible(c, { validate: false });
            if (ckbDelta.lt(minimalCapacity)) {
                throw Error("Missing CKB: not enough funds to execute the transaction");
            }
            c.cellOutput.capacity = minimalCapacity.toHexString();
            changeCells.push(c);
            ckbDelta = ckbDelta.sub(minimalCapacity);
        }

        const ickbDeposits: Cell[] = [];
        const ownedCells: Cell[] = [];
        for (const cell of this.outputs.filter((cell) =>
            scriptEq(cell.cellOutput.lock, defaultScript("DOMAIN_LOGIC")))) {
            if (isDAODeposit(cell)) {
                ickbDeposits.push(cell);
            } else {
                ownedCells.push(cell);
            }
        }

        //Maybe add an Owner Lock cell to enable later conversion from Receipt to iCKB
        if (ickbDeposits.length > 0 && ownedCells.length == 0) {
            const ownerLockCell: Cell = {
                cellOutput: {
                    capacity: "0x42",
                    lock: defaultScript("DOMAIN_LOGIC"),
                    type: undefined
                },
                data: "0x"
            }
            changeCellsPush(ownerLockCell);
            ownedCells.push(ownerLockCell);
        }

        //Maybe add iCKB receipt cell
        if (ownedCells.length > 0) {
            const receipt = {
                cellOutput: {
                    capacity: "0x42",
                    lock: this.getAccountLock(),
                    type: defaultScript("DOMAIN_LOGIC")
                },
                data: hexify(ReceiptCodec.pack({
                    ownedQuantity: ownedCells.length,
                    depositQuantity: ickbDeposits.length,
                    depositAmount: ickbDeposits.length > 0 ?
                        BI.from(ickbDeposits[0].cellOutput.capacity)
                            .sub(minimalCellCapacityCompatible(ickbDeposits[0]))
                        : BI.from(0)
                }))
            };
            changeCellsPush(receipt);
        }

        //Add iCKB SUDT change cell
        const ickbDelta = await this.getIckbDelta(changeCells);
        if (ickbDelta.lt(0)) {
            throw Error("Missing iCKB SUDT: not enough funds to execute the transaction");
        } else if (ickbDelta.eq(0)) {
            //Do nothing
        } else {
            const sudtChangeCell = {
                cellOutput: {
                    capacity: "0x42",
                    lock: this.accountLock,
                    type: ickbSudtType()
                },
                data: hexify(Uint128LE.pack(ickbDelta))
            }
            changeCellsPush(sudtChangeCell);
        }

        return super.toChange(ckbDelta, changeCells);
    }

    async getIckbDelta(changeCells: Cell[]) {
        let ickbDelta = BI.from(0);
        for (const c of this.inputs) {
            //iCKB token
            if (scriptEq(c.cellOutput.type, ickbSudtType())) {
                ickbDelta = ickbDelta.add(Uint128LE.unpack(c.data));
                continue;
            }

            //Withdrawal from iCKB pool of NervosDAO deposits
            if (scriptEq(c.cellOutput.lock, defaultScript("DOMAIN_LOGIC")) && isDAODeposit(c)) {
                const header = await this.getHeaderByNumber(c.blockNumber!);
                const ckbUnoccupiedCapacity = BI.from(c.cellOutput.capacity).sub(minimalCellCapacityCompatible(c, { validate: false }));
                ickbDelta = ickbDelta.sub(ickbEquivalentValue(ckbUnoccupiedCapacity, header));
                continue;
            }

            //iCKB Receipt
            if (scriptEq(c.cellOutput.type, defaultScript("DOMAIN_LOGIC"))) {
                const header = await this.getHeaderByNumber(c.blockNumber!);
                const { depositQuantity, depositAmount } = ReceiptCodec.unpack(c.data);
                ickbDelta = ickbDelta.add(receiptIckbEquivalentValue(depositQuantity, depositAmount, header));
            }
        }

        for (const c of [...this.outputs, ...changeCells]) {
            //iCKB token
            if (scriptEq(c.cellOutput.type, ickbSudtType())) {
                ickbDelta = ickbDelta.sub(Uint128LE.unpack(c.data));
            }
        }

        return ickbDelta;
    }
}

export function ickbSudtType(): Script {
    return {
        ...defaultScript("SUDT"),
        args: computeScriptHash(defaultScript("DOMAIN_LOGIC"))
    };
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

export function ickbEquivalentValue(ckbUnoccupiedCapacity: BI, header: Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    let ickbAmount = ckbUnoccupiedCapacity.mul(AR_0).div(AR_m);
    if (ICKB_SOFT_CAP_PER_DEPOSIT.lt(ickbAmount)) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickbAmount = ickbAmount.sub(ickbAmount.sub(ICKB_SOFT_CAP_PER_DEPOSIT).div(10));
    }

    return ickbAmount;
}

export function receiptIckbEquivalentValue(receiptCount: BIish, receiptAmount: BI, header: Header) {
    return ickbEquivalentValue(receiptAmount, header).mul(receiptCount);
}

export function ckbSoftCapPerDeposit(header: Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    return ICKB_SOFT_CAP_PER_DEPOSIT.mul(AR_m).div(AR_0).add(1);
}