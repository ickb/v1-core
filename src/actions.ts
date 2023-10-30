import { defaultScript, epochCompare, fund as baseFund, getRpc, getSyncedIndexer, isDAOWithdrawal, parseEpoch, TransactionBuilder, DAO_DEPOSIT_DATA, isDAODeposit } from "lumos-utils";
import { IckbTransactionBuilder, ReceiptCodec, ickbSudtType } from "./domain_logic";
import { Cell, Header } from "@ckb-lumos/base";
import { CellCollector } from "@ckb-lumos/ckb-indexer";
import { BI, parseUnit } from "@ckb-lumos/bi";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { Uint64LE } from "@ckb-lumos/codec/lib/number";

export function deposit(transactionBuilder: IckbTransactionBuilder, depositQuantity: number, depositAmount: BI): IckbTransactionBuilder {
    if (depositQuantity > 61) {
        throw Error(`depositQuantity is ${depositQuantity}, but should be less than 62`);
    }

    // Create depositQuantity deposits of occupied capacity + depositAmount.
    const deposit = {
        cellOutput: {
            capacity: parseUnit("82", "ckb").add(depositAmount).toHexString(),
            lock: defaultScript("DOMAIN_LOGIC"),
            type: defaultScript("DAO"),
        },
        data: DAO_DEPOSIT_DATA
    };

    //transactionBuilder.toChange() will take care of adding the receipt and owner lock

    return transactionBuilder.add("output", "end", ...Array.from({ length: depositQuantity }, () => deposit));
}

export function withdrawFrom(transactionBuilder: IckbTransactionBuilder, ...deposits: Cell[]): IckbTransactionBuilder {
    const withdrawals: Cell[] = [];
    for (const deposit of deposits) {
        const withdrawal = {
            cellOutput: deposit.cellOutput!,
            data: hexify(Uint64LE.pack(BI.from(deposit.blockNumber)))
        };
        withdrawals.push(withdrawal);
    }

    //transactionBuilder.toChange() will take care of adding the receipt

    return transactionBuilder.add("input", "start", ...deposits)
        .add("output", "start", ...withdrawals);
}

export async function fund(transactionBuilder: IckbTransactionBuilder, addAll: boolean = false, tipHeader?: Header): Promise<IckbTransactionBuilder> {
    tipHeader = tipHeader ?? await getRpc().getTipHeader();
    const is_well_funded = addAll ? async () => false : async () => {
        try {
            await transactionBuilder.toTransactionSkeleton()
            return true;
        } catch (e: any) {
            //Improve error typing or define this function on builder itself/////////////////////////////////////////
            if (e.message === "Missing CKB: not enough funds to execute the transaction") {
                return false;
            }

            if (e.message === "Missing iCKB SUDT: not enough funds to execute the transaction") {
                return false;
            }
            throw e;
        }
    }

    if (await is_well_funded()) {
        return transactionBuilder;
    }

    const indexer = await getSyncedIndexer();

    //Try adding receipts and see if it helps
    const tipEpoch = parseEpoch(tipHeader.epoch);//Maybe pass as parameter to the fund function///
    for await (const receiptCell of new CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        type: defaultScript("DOMAIN_LOGIC"),
        lock: transactionBuilder.getAccountLock()
    }).collect()) {
        //Add owned cells referenced in the receipt
        let ownedCells: Cell[] = [];
        for await (const ownedCell of new CellCollector(indexer, {
            scriptSearchMode: "exact",
            withData: true,
            lock: defaultScript("DOMAIN_LOGIC"),
            fromBlock: receiptCell.blockNumber,
            toBlock: receiptCell.blockNumber,
        }).collect()) {
            //Add only cells in this receipt
            if (ownedCell.outPoint!.txHash != receiptCell.outPoint!.txHash) {
                continue;
            }
            //Deposit cells are not part of the owned cells
            if (isDAODeposit(ownedCell)) {
                continue;
            }

            //For now only Owner Lock cells and Withdrawal Requests are supported

            //Check if it's an owner lock cell
            if (ownedCell.cellOutput.type == undefined) {
                ownedCells.push(ownedCell);
                continue;
            }

            //Check if is a withdrawal request
            if (isDAOWithdrawal(ownedCell)) {
                const maturityEpoch = parseEpoch(await transactionBuilder.withdrawedDaoSince(ownedCell));
                if (epochCompare(maturityEpoch, tipEpoch) < 1) {//Withdrawal request is ripe
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
    for await (const sudtCell of new CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        type: ickbSudtType(),
        lock: transactionBuilder.getAccountLock()
    }).collect()) {
        transactionBuilder.add("input", "end", sudtCell);

        if (await is_well_funded()) {
            return transactionBuilder;
        }
    }

    return baseFund(transactionBuilder, addAll, tipHeader) as Promise<IckbTransactionBuilder>;
}