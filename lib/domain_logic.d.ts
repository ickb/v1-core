import { Cell, Header, Script } from "@ckb-lumos/base";
import { BI, BIish } from "@ckb-lumos/bi";
import { TransactionBuilder } from "lumos-utils";
export declare class IckbTransactionBuilder extends TransactionBuilder {
    toChange(ckbDelta: BI, changeCells?: Cell[]): Promise<Cell[]>;
    getIckbDelta(changeCells: Cell[]): Promise<BI>;
}
export declare function ickbSudtType(): Script;
export declare const ReceiptCodec: import("@ckb-lumos/codec/lib/molecule/layout").ObjectCodec<{
    ownedQuantity: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<number, BIish>;
    depositQuantity: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<number, BIish>;
    depositAmount: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<BI, BIish>;
}> & import("@ckb-lumos/codec/lib/base").Fixed;
export declare const AR_0: BI;
export declare const ICKB_SOFT_CAP_PER_DEPOSIT: BI;
export declare function ickbEquivalentValue(ckbUnoccupiedCapacity: BI, header: Header): BI;
export declare function receiptIckbEquivalentValue(receiptCount: BIish, receiptAmount: BI, header: Header): BI;
export declare function ckbSoftCapPerDeposit(header: Header): BI;
//# sourceMappingURL=domain_logic.d.ts.map