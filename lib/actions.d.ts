import { IckbTransactionBuilder } from "./domain_logic";
import { Cell } from "@ckb-lumos/base";
import { BI } from "@ckb-lumos/bi";
export declare function deposit(transactionBuilder: IckbTransactionBuilder, depositQuantity: number, depositAmount: BI): IckbTransactionBuilder;
export declare function withdrawFrom(transactionBuilder: IckbTransactionBuilder, ...deposits: Cell[]): IckbTransactionBuilder;
export declare function fund(transactionBuilder: IckbTransactionBuilder): Promise<IckbTransactionBuilder>;
//# sourceMappingURL=actions.d.ts.map