"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ickbSudtScript = void 0;
const utils_1 = require("@ckb-lumos/base/lib/utils");
const lumos_utils_1 = require("lumos-utils");
function ickbSudtScript() {
    return {
        ...(0, lumos_utils_1.defaultScript)("SUDT"),
        args: (0, utils_1.computeScriptHash)((0, lumos_utils_1.defaultScript)("DOMAIN_LOGIC"))
    };
}
exports.ickbSudtScript = ickbSudtScript;
//# sourceMappingURL=utils.js.map