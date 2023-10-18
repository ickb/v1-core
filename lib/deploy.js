"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const rpc_1 = require("@ckb-lumos/rpc");
const utils_1 = require("@ckb-lumos/base/lib/utils");
const hd_1 = require("@ckb-lumos/hd");
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const lumos_utils_1 = require("lumos-utils");
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3 || !isBuildType(args[0]) || !(0, lumos_utils_1.isChain)(args[1])) {
        throw Error("Invalid command line arguments " + args.join(" "));
    }
    const [buildType, chain, rpcUrl] = args;
    await (0, lumos_utils_1.initializeChainAdapter)(chain, undefined, rpcUrl);
    const scriptData = await ickbScriptData(buildType, chain);
    if (chain === "devnet") {
        scriptData.unshift(await sudtScriptData());
    }
    if (chain !== "devnet") {
        throw Error("To be implemented...");
    }
    const privKey = "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc";
    const pubKey = hd_1.key.privateToPublic(privKey);
    const accountLock = {
        ...(0, lumos_utils_1.defaultScript)("SECP256K1_BLAKE160"),
        args: hd_1.key.publicKeyToBlake160(pubKey)
    };
    const tbb = () => new lumos_utils_1.TransactionBuilder(accountLock, (0, lumos_utils_1.secp256k1SignerFrom)(privKey));
    console.log("Deploying iCKB contracts...");
    let txHash = await (0, lumos_utils_1.deploy)(tbb(), scriptData);
    console.log(txHash);
    console.log();
    console.log("Creating iCKB contracts depGroup...");
    txHash = await (0, lumos_utils_1.createDepGroup)(tbb(), ["SECP256K1_BLAKE160", "DAO", "SUDT", ...scriptData.map(s => s.name)]);
    console.log(txHash);
    console.log();
    await (0, promises_1.writeFile)(`config.json`, JSON.stringify((0, lumos_utils_1.getConfig)(), null, 2));
    console.log("Generated config:");
    console.log((0, lumos_utils_1.getConfig)());
}
async function ickbScriptData(buildType, chain) {
    (0, child_process_1.execSync)(`cd .. && capsule build ${buildType2Flag[buildType]} -- --features ${chain};`);
    console.log();
    const result = [];
    for (const name of (await (0, promises_1.readdir)(folderPath))) {
        const rawData = await (0, promises_1.readFile)(folderPath + name);
        result.push({
            name: name.toUpperCase(),
            hexData: "0x" + rawData.toString("hex"),
            codeHash: (0, utils_1.ckbHash)(rawData),
            hashType: "data1"
        });
    }
    return result;
}
const folderPath = "../build/release/";
const buildType2Flag = {
    release: "--release",
    debug: "--debug-output --release"
};
function isBuildType(x) {
    return buildType2Flag.hasOwnProperty(x);
}
async function sudtScriptData() {
    const rpc = new rpc_1.RPC((0, lumos_utils_1.defaultRpcUrl)("mainnet"), { timeout: 10000 });
    const sudtCell = (await rpc.getLiveCell({
        txHash: "0xc7813f6a415144643970c2e88e0bb6ca6a8edc5dd7c1022746f628284a9936d5",
        index: "0x0"
    }, true)).cell;
    const result = {
        name: "SUDT",
        hexData: sudtCell.data.content,
        codeHash: sudtCell.data.hash,
        hashType: "data"
    };
    return result;
}
main();
//# sourceMappingURL=deploy.js.map