import { Script } from "@ckb-lumos/base";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { defaultScript } from "lumos-utils";


export function ickbSudtScript(): Script {
    return {
        ...defaultScript("SUDT"),
        args: computeScriptHash(defaultScript("DOMAIN_LOGIC"))
    };
}