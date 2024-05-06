import {
    I8CellDep, I8OutPoint, I8Script, ScriptConfigAdapter, cellDeps, defaultScript,
    getChainInfo, i8ScriptPadding, initializeConfig, getConfig
} from "@ickb/lumos-utils";
import { BI } from "@ckb-lumos/bi";
import devnetMigration from '../scripts/deployment/devnet/migrations/latest.json';
import type { ScriptConfigs } from "@ckb-lumos/config-manager/lib/types.js";

const errorConfigNotAvailable = "The requested config is not available";
export function initializeIckbConfig() {
    if (getChainInfo().chain != "devnet") {
        throw Error(errorConfigNotAvailable);
    }

    const { cell_recipes, dep_group_recipes } = devnetMigration;
    const { tx_hash, index } = dep_group_recipes[0];
    const outPoint = I8OutPoint.from({ txHash: tx_hash, index: BI.from(index).toHexString() });

    const newScriptConfig: ScriptConfigs = {};
    for (const c of cell_recipes) {
        newScriptConfig[c.name] = new ScriptConfigAdapter(
            I8Script.from({
                ...i8ScriptPadding,
                codeHash: c.type_id ?? c.data_hash,
                hashType: c.type_id ? "type" : "data1",
                [cellDeps]: [I8CellDep.from({ outPoint, depType: "depGroup" })]
            })
        );
    }

    for (const name of ["SECP256K1_BLAKE160", "DAO", "SECP256K1_DATA", "SECP256K1_BLAKE160_MULTISIG"]) {
        const s = defaultScript(name);
        newScriptConfig[name] = new ScriptConfigAdapter(
            I8Script.from({
                ...s,
                [cellDeps]: [I8CellDep.from({ outPoint, depType: "depGroup" })]
            })
        );
    }

    const oldConfig = getConfig();
    initializeConfig({
        PREFIX: oldConfig.PREFIX,
        SCRIPTS: { ...oldConfig.SCRIPTS, ...newScriptConfig }
    });
}