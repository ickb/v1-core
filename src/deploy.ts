import { RPC } from "@ckb-lumos/rpc";
import { ckbHash } from "@ckb-lumos/base/lib/utils";
import { execSync } from "child_process";
import { readFile, readdir, writeFile } from "fs/promises";
import {
    Chain, DeployScriptData, I8Cell, I8OutPoint, addCells, capacitiesSifter, ckbFundAdapter,
    createDepGroup, defaultRpcUrl, deploy, fund, getCells, initializeChainAdapter,
    isChain, scriptNames, secp256k1Blake160, sendTransaction, serializeConfig
} from "@ickb/lumos-utils";
import { TransactionSkeleton } from "@ckb-lumos/helpers";
import { BI } from "@ckb-lumos/bi";

async function main() {
    const args = process.argv.slice(2);
    const [buildType, chain, rpcUrl, clientType] = args;

    if (args.length < 2 || args.length > 4
        || !isBuildType(buildType)
        || !isChain(chain)
        || !(clientType in clientType2IsLightClient)) {
        throw Error("Invalid command line arguments " + args.join(" "));
    }

    await initializeChainAdapter(chain, undefined, rpcUrl, clientType2IsLightClient[clientType]);

    const scriptData = await ickbScriptData(buildType, chain);
    if (chain === "devnet") {
        scriptData.unshift(await sudtScriptData());
    }

    if (chain !== "devnet") {
        throw Error("To be implemented...")
    }

    //Genesis devnet account
    const {
        lockScript,
        expander,
        preSigner,
        signer
    } = secp256k1Blake160(
        "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc"
    );

    const commit = async (cells: Iterable<I8Cell>) => {
        const { owned: capacities } = capacitiesSifter(
            (await getCells({
                script: lockScript,
                scriptType: "lock",
                filter: {
                    scriptLenRange: ["0x0", "0x1"],
                    outputDataLenRange: ["0x0", "0x1"],
                },
                scriptSearchMode: "exact"
            })),
            expander
        );
        // const feeRate = await getFeeRate();
        const feeRate = 1000;
        let tx = addCells(TransactionSkeleton(), "append", [], cells);
        const outputs = tx.outputs;
        tx = fund(tx, ckbFundAdapter(
            lockScript,
            feeRate,
            preSigner,
            capacities
        ));
        const txHash = await sendTransaction(signer(tx));
        return outputs.map((_, index) => I8OutPoint.from({ txHash, index: BI.from(index).toHexString() }))
    }

    console.log("Deploying iCKB contracts...");
    let config = await deploy(scriptData, commit);
    console.log("Generated config:");
    console.log(serializeConfig(config));
    console.log();

    console.log("Creating iCKB contracts depGroup...");
    config = await createDepGroup(scriptNames(), commit);
    await writeFile(`config.json`, serializeConfig(config));
    console.log("Generated config:");
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

function isBuildType(x: string): x is BuildType {
    return buildType2Flag.hasOwnProperty(x);
}

const clientType2IsLightClient: { [id: string]: boolean } = {
    "light": true,
    "full": false,
    undefined: false
};

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