import { RPC } from "@ckb-lumos/rpc";
import { ckbHash } from "@ckb-lumos/base/lib/utils";
import { execSync } from "child_process";
import { readFile, readdir, writeFile } from "fs/promises";
import {
    Chain, DeployScriptData, I8Cell, I8OutPoint, addCells, ckbFundAdapter,
    createDepGroup, defaultRpcUrl, deploy, fund, getFeeRate, initializeChainAdapter,
    isChain, secp256k1Blake160, sendTransaction, serializeConfig
} from "@ickb/lumos-utils";
import { TransactionSkeleton } from "@ckb-lumos/helpers";
import { BI, parseUnit } from "@ckb-lumos/bi";

async function main() {
    const {
        CHAIN,
        BUILD_TYPE,
        RPC_URL,
        CLIENT_TYPE,
        DEPLOY_PRIVATE_KEY,
        BOT_PRIVATE_KEY,
        INTERFACE_PRIVATE_KEY
    } = process.env;
    if (!isChain(CHAIN)) {
        throw Error("Invalid env CHAIN: " + CHAIN);
    }
    if (CHAIN === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }
    if (!isBuildType(BUILD_TYPE)) {
        throw Error("Invalid env BUILD_TYPE: " + BUILD_TYPE);
    }
    if (!DEPLOY_PRIVATE_KEY) {
        throw Error("Empty env DEPLOY_PRIVATE_KEY")
    }
    await initializeChainAdapter(CHAIN, undefined, RPC_URL, CLIENT_TYPE === "light" ? true : undefined);
    const { lockScript, preSigner, signer, getCapacities, transfer } = secp256k1Blake160(DEPLOY_PRIVATE_KEY);

    if (CHAIN === "devnet" && BOT_PRIVATE_KEY) {
        console.log("Funding fulfillment bot");
        const botAccount = secp256k1Blake160(BOT_PRIVATE_KEY);
        const txHash = await transfer(botAccount.lockScript, parseUnit("1000000", "ckb"));
        console.log(txHash);
    }
    if (CHAIN === "devnet" && INTERFACE_PRIVATE_KEY) {
        console.log("Funding limit order creator");
        const interfaceAccount = secp256k1Blake160(INTERFACE_PRIVATE_KEY);
        const txHash = await transfer(interfaceAccount.lockScript, parseUnit("10000000", "ckb"));
        console.log(txHash);
    }

    const commit = async (cells: readonly I8Cell[]) => {
        const capacities = await getCapacities();
        const feeRate = await getFeeRate();
        let tx = addCells(TransactionSkeleton(), "append", [], cells);
        tx = fund(tx, ckbFundAdapter(lockScript, feeRate, preSigner, capacities));
        const txHash = await sendTransaction(signer(tx));
        return cells.map((c, i) => {
            if (tx.outputs.get(i) !== c) {
                throw Error("Unexpected cell position mismatch")
            }
            return I8OutPoint.from({
                txHash,
                index: BI.from(i).toHexString()
            });
        });
    }

    console.log("Deploying iCKB contracts...");
    const scriptData = await ickbScriptData(BUILD_TYPE, CHAIN);
    if (CHAIN === "devnet") {
        scriptData.unshift(await sudtScriptData());
    }
    let config = await deploy(scriptData, commit);

    console.log("Creating iCKB contracts depGroup...");
    config = await createDepGroup(["SECP256K1_BLAKE160", "DAO", "SUDT", "ICKB_LOGIC", "LIMIT_ORDER"], commit);
    console.log();
    await writeFile(`env/${CHAIN}/config.json`, serializeConfig(config));
    console.log(`All done, env/${CHAIN}/config.json.json now contains the following config:`);
    console.log(serializeConfig(config));
    console.log();
}

async function ickbScriptData(buildType: BuildType, chain: Chain) {
    execSync(`capsule build ${buildType2Flag[buildType]} -- --features ${chain};`);
    console.log();
    const result: DeployScriptData[] = [];
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

function isBuildType(x: string | undefined): x is BuildType {
    return x === undefined ? false : buildType2Flag.hasOwnProperty(x);
}

async function sudtScriptData() {
    const rpc = new RPC(defaultRpcUrl("mainnet"), { timeout: 10000 });
    const sudtCell = (await rpc.getLiveCell({
        txHash: "0xc7813f6a415144643970c2e88e0bb6ca6a8edc5dd7c1022746f628284a9936d5",
        index: "0x0"
    }, true)).cell;

    const result: DeployScriptData = {
        name: "SUDT",
        hexData: sudtCell.data.content,
        codeHash: sudtCell.data.hash,
        hashType: "data"
    }

    return result;
}

main();