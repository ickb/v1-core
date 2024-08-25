#! /bin/bash
genesis_block=$(ckb-cli rpc get_block_by_number --number 0 --no-color);
export genesis_tx_hash=$(echo "$genesis_block" | grep --color=never -Po 'hash:\s\K.*' | head -n 5 | tail -n 1);
export address="ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqwgx292hnvmn68xf779vmzrshpmm6epn4c0cgwga";

cat template.toml | envsubst > deployment.toml;
rm -fr migrations/*;
rm deploy-tx.json;

ckb-cli deploy gen-txs --deployment-config ./deployment.toml --migration-dir ./migrations --from-address $address --sign-now --info-file deploy-tx.json;
ckb-cli deploy apply-txs --info-file ./deploy-tx.json --migration-dir ./migrations;

mv migrations/* migrations/latest.json;
