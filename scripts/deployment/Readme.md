# Deployment

Deploy commands:

```bash
rm deploy-tx.json;

export API_URL="https://testnet.ckb.dev";

ckb-cli deploy gen-txs --deployment-config ./deployment.toml --migration-dir ./migrations --from-address ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt39x0xz5k9qy90ah9v8880j29a72qmrtqrduh0m --sign-now --info-file deploy-tx.json

ckb-cli deploy apply-txs --info-file ./deploy-tx.json --migration-dir ./migrations
```
