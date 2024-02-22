# iCKB v1 core

## Deploy contracts on testnet

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-core.git
```

2. Enter into the repo's folder:

```bash
cd v1-core/
```

3. Install dependencies:

```bash
npm i
```

4. Define a `env/testnet/.env` file, for example:

```
CHAIN=testnet
BUILD_TYPE=release
DEPLOY_PRIVATE_KEY=0x-YOUR-SECP256K1-BLAKE160-PRIVATE-KEY
```

Optionally the property `RPC_URL` can also be specified:

```
RPC_URL=http://127.0.0.1:8114/
```

5. Deploy the contracts:

```bash
npm run deploy --chain=testnet
```

## Licensing

The license is the MIT License, see the [`LICENSE`](./LICENSE).
