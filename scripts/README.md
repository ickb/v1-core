# iCKB v1 core scripts

## Building the scripts

1. Install cargo, rust and docker. (Version seems irrelevant to the build)
2. Install cross `rev=6982b6c` locked:

```bash
cargo install cross --git https://github.com/cross-rs/cross --rev=6982b6c --locked
```

3. Install capsule `rev=04fd58c`  (v0.10.5) locked:

```bash
cargo install ckb-capsule --git https://github.com/nervosnetwork/capsule --rev=04fd58c --locked
```

4. Build for release:

```bash
capsule build --release
```

## Note on Build Reproducibility

As per [capsule Readme](https://github.com/nervosnetwork/capsule?tab=readme-ov-file#installation), the following steps should enable reproducible builds:
> docker - Capsule uses docker container to reproducibly build contracts.
