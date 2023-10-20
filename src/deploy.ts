import { RPC } from "@ckb-lumos/rpc";
import { ckbHash } from "@ckb-lumos/base/lib/utils";
import { key } from "@ckb-lumos/hd";
import { execSync } from "child_process";
import { readFile, readdir, writeFile } from "fs/promises";
import {
    Chain, ScriptData, TransactionBuilder, createDepGroup,
    defaultRpcUrl, defaultScript, deploy, getConfig,
    initializeChainAdapter, isChain, secp256k1SignerFrom
} from "lumos-utils";

async function main() {
    const args = process.argv.slice(2)
    if (args.length < 2 || args.length > 3 || !isBuildType(args[0]) || !isChain(args[1])) {
        throw Error("Invalid command line arguments " + args.join(" "));
    }

    const [buildType, chain, rpcUrl] = args;
    await initializeChainAdapter(chain, undefined, rpcUrl);

    const scriptData = await ickbScriptData(buildType, chain);
    if (chain === "devnet") {
        scriptData.unshift(await sudtScriptData());
    }

    if (chain !== "devnet") {
        throw Error("To be implemented...")
    }
    const privKey = "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc";
    const pubKey = key.privateToPublic(privKey);
    const accountLock = {
        ...defaultScript("SECP256K1_BLAKE160"),
        args: key.publicKeyToBlake160(pubKey)
    }
    const tbb = () => new TransactionBuilder(accountLock, secp256k1SignerFrom(privKey));

    console.log("Deploying iCKB contracts...");
    let txHash = await deploy(tbb(), scriptData);
    console.log(txHash);
    console.log();

    console.log("Creating iCKB contracts depGroup...");
    txHash = await createDepGroup(tbb(), ["SECP256K1_BLAKE160", "DAO", "SUDT", ...scriptData.map(s => s.name)]);
    console.log(txHash);
    console.log();

    await writeFile(`config.json`, JSON.stringify(getConfig(), null, 2));
    console.log("Generated config:");
    console.log(getConfig());
}

async function ickbScriptData(buildType: BuildType, chain: Chain) {
    execSync(`capsule build ${buildType2Flag[buildType]} -- --features ${chain};`);
    console.log();
    const result: ScriptData[] = [];
    for (const name of (await readdir(folderPath))) {
        const rawData = await readFile(folderPath + name);
        result.push({
            name: name.toUpperCase(),
            hexData: "0x" + rawData.toString("hex"),
            codeHash: ckbHash(rawData),
            hashType: "data1"
        });
    }
    return result;
}

const folderPath = "build/release/";
const buildType2Flag = {
    release: "--release",
    debug: "--debug-output --release"
};

type BuildType = keyof typeof buildType2Flag;

function isBuildType(x: string): x is BuildType {
    return buildType2Flag.hasOwnProperty(x);
}

async function sudtScriptData() {
    const rpc = new RPC(defaultRpcUrl("mainnet"), { timeout: 10000 });
    const sudtCell = (await rpc.getLiveCell({
        txHash: "0xc7813f6a415144643970c2e88e0bb6ca6a8edc5dd7c1022746f628284a9936d5",
        index: "0x0"
    }, true)).cell;

    const result: ScriptData = {
        name: "SUDT",
        hexData: sudtCell.data.content,
        codeHash: sudtCell.data.hash,
        hashType: "data"
    }

    return result;
}

main();