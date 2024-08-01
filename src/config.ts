import {
  I8CellDep,
  I8OutPoint,
  I8Script,
  ScriptConfigAdapter,
  cellDeps,
  i8ScriptPadding,
  hex,
} from "@ickb/lumos-utils";
import type { Chain } from "@ickb/lumos-utils";
import devnetMigration from "../scripts/deployment/devnet/migrations/latest.json";
import testnetMigration from "../scripts/deployment/testnet/migrations/2024-08-01-090441.json";

const errorConfigNotAvailable = "The requested config is not available";
const errorMissingScriptInConfig =
  "The requested script is missing in the old config";
export function getIckbScriptConfigs(
  chain: Chain,
  oldScriptConfigs: { [id: string]: ScriptConfigAdapter },
) {
  if (chain === "mainnet") {
    throw Error(errorConfigNotAvailable);
  }

  const { cell_recipes, dep_group_recipes } =
    chain === "testnet" ? testnetMigration : devnetMigration;
  const { tx_hash, index } = dep_group_recipes[0];
  const outPoint = I8OutPoint.from({ txHash: tx_hash, index: hex(index) });

  const newScriptConfig: typeof oldScriptConfigs = {};
  for (const c of cell_recipes) {
    newScriptConfig[c.name] = new ScriptConfigAdapter(
      I8Script.from({
        ...i8ScriptPadding,
        codeHash: c.type_id ?? c.data_hash,
        hashType: c.type_id ? "type" : "data1",
        [cellDeps]: [I8CellDep.from({ outPoint, depType: "depGroup" })],
      }),
    );
  }

  const names = ["SECP256K1_BLAKE160", "DAO", "SECP256K1_BLAKE160_MULTISIG"];
  // On devnet XUDT is deployed along iCKB contracts, while on testnet and mainnet is deployed externally
  if (chain === "devnet") {
    // Do nothing
  } else if (chain === "testnet") {
    // Lumos XUDT predefined uses type, but we need data1, see: https://github.com/ckb-js/lumos/issues/735
    names.push("XUDT");
    oldScriptConfigs = {
      ...oldScriptConfigs,
      XUDT: new ScriptConfigAdapter(
        I8Script.from({
          ...i8ScriptPadding,
          codeHash:
            "0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95",
          hashType: "data1",

          [cellDeps]: [
            I8CellDep.from({
              outPoint: I8OutPoint.from({
                txHash:
                  "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f",
                index: "0x0",
              }),
              depType: "code",
            }),
          ],
        }),
      ),
    };
  } else {
    // chain === "mainnet"
    // Lumos XUDT configuration for mainnet is already data1
    if (oldScriptConfigs["XUDT"].HASH_TYPE !== "data1") {
      throw Error("Expected data1 hashType for XUDT");
    }
    names.push("XUDT");
  }

  for (const name of names) {
    const s = oldScriptConfigs[name];
    if (!s) {
      throw Error(errorMissingScriptInConfig);
    }
    newScriptConfig[name] = new ScriptConfigAdapter(
      I8Script.from({
        ...s.defaultScript,
        [cellDeps]: [I8CellDep.from({ outPoint, depType: "depGroup" })],
      }),
    );
  }

  return newScriptConfig;
}
