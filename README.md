# iCKB v1 core

## Setup

### Deploy contracts on local devchain

0. Start local devnet, refer to the [Complete Setup section](#complete-setup) for further instructions:

```bash
(trap 'kill -INT 0' SIGINT; cd ~/ckb/; ckb run --indexer & sleep 5 && ckb miner)
```

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-core.git
```

2. Enter into the repo's utils folder:

```bash
cd v1-core/utils
```

3. Install utils dependencies:

```bash
npm i
```

4. Build and deploy the release version of contracts on devnet:

```bash
npm run deploy release devnet
```

## Complete Setup

### Environment Setup

0. Enter home:

```bash
cd ~;
```

1. Download [`ckb 0.111.0 (Portable)`](https://github.com/nervosnetwork/ckb/releases/tag/v0.111.0):

```bash
wget https://github.com/nervosnetwork/ckb/releases/download/v0.111.0/ckb_v0.111.0_x86_64-unknown-linux-gnu-portable.tar.gz
```

2. Create a `~/ckb` directory:

```bash
mkdir ~/ckb
```

3. Extract the `ckb` compressed folder into `~/ckb`

```bash
tar --extract --file=ckb_v0.111.0_x86_64-unknown-linux-gnu-portable.tar.gz --strip-components=1 --directory=ckb
```

3. Install [capsule v0.10.1](https://github.com/nervosnetwork/capsule)

### Devchain configuration

This is section takes material from both [Nervos devchain guide](https://docs.nervos.org/docs/basics/guides/devchain/) and [Ian instructions](https://talk.nervos.org/t/is-there-any-way-to-speed-up-the-blockchain-in-a-way-that-180-epochs-happen-in-a-reasonable-time-frame-in-the-local-devchain/7163).

From within `~/ckb`:

1. Init devchain:

```bash
ckb init --chain dev
```

2. In the `ckb.toml` file under the `[block_assembler]` section set:

```toml
[block_assembler]
code_hash = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"
args = "0xc8328aabcd9b9e8e64fbc566c4385c3bdeb219d7" # ckt1...gwga account
hash_type = "type"
message = "0x"
```

3. In the `ckb.toml` file under the `[logger]` section set:

```toml
[logger]
filter = "ckb-script=debug"# instead of "info"
# Other parameters...
```

4. In the `specs/dev.toml` file under the `[params]` section set:

``` toml
[params]
# Other parameters...
epoch_duration_target = 2 # instead of 14400
genesis_epoch_length = 2 # instead of 1000
permanent_difficulty_in_dummy = true
```

5. In the `ckb-miner.toml` file under the `[miner.client]` section set:

``` toml
[miner.client]
# Other parameters...
poll_interval = 100 # instead of 1000
```

6. In the `ckb-miner.toml` file under the `[[miner.workers]]` section set:

``` toml
[[miner.workers]]
# Other parameters...
value = 200 # instead of 5000
```

7. In a new terminal start ckb node and miner:

```bash
(trap 'kill -INT 0' SIGINT; cd ~/ckb/; ckb run --indexer & sleep 5 && ckb miner)
```

8. Create Private Key Files:

```bash
echo 0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc > pk1
echo 0x63d86723e08f0f813a36ce6aa123bb2289d90680ae1e99d4de8cdb334553f24d > pk2
```

9. Import the Private Keys:

```bash
ckb-cli account import --privkey-path pk1
ckb-cli account import --privkey-path pk2
```

### Run the project

Please refer to the [initial Setup section](#setup).

## Licensing

The license is the MIT License, see the [`LICENSE`](./LICENSE).
