import { Cell, Header, Hexadecimal, Script } from "@ckb-lumos/base";
import { BI, BIish } from "@ckb-lumos/bi";
import { TransactionSkeletonType } from "@ckb-lumos/helpers";
import { TransactionBuilder } from "lumos-utils";
export declare class IckbTransactionBuilder extends TransactionBuilder {
    protected toChange(ckbDelta: BI, changeCells?: Cell[]): Promise<any>;
    getIckbDelta(inputs?: Cell[], outputs?: Cell[]): Promise<BI>;
    protected getHeaderDepsBlockNumbers(transaction: TransactionSkeletonType): Promise<Hexadecimal[]>;
}
export declare function ickbSudtType(): Script;
export declare const ReceiptCodec: import("@ckb-lumos/codec/lib/molecule/layout").ObjectCodec<{
    ownedQuantity: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<number, BIish>;
    depositQuantity: import("@ckb-lumos/codec/lib/base").FixedBytesCodec<number, BIish>;
    depositAmount: any;
}> & import("@ckb-lumos/codec/lib/base").Fixed;
export declare const AR_0: BI;
export declare const ICKB_SOFT_CAP_PER_DEPOSIT: BI;
export declare function ickbEquivalentValue(ckbUnoccupiedCapacity: BI, header: Header): BI;
export declare function receiptIckbEquivalentValue(receiptCount: BIish, receiptAmount: BI, header: Header): BI;
export declare function ckbSoftCapPerDeposit(header: Header): BI;
//# sourceMappingURL=domain_logic.d.ts.map