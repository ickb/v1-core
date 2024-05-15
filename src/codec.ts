import { bytes, createBytesCodec } from '@ckb-lumos/codec';
import type { PackParam, UnpackResult } from '@ckb-lumos/codec';
import { UdtData, PartialOrderData } from './encoding.js';
import { OutPoint as OP } from "@ckb-lumos/base/lib/blockchain.js";
import type { ObjectLayoutCodec } from "@ckb-lumos/codec/lib/molecule/layout.js";
import type { BytesLike, Fixed, FixedBytesCodec } from "@ckb-lumos/codec/lib/base.js";

export { Uint8, Uint32, Uint64, Uint128, Int32 } from '@ickb/lumos-utils';

export type PackableOrder = PackParam<typeof UdtData> & PackParam<typeof PartialOrderData>;
export type UnpackedOrder = UnpackResult<typeof UdtData> & UnpackResult<typeof PartialOrderData>;

export const OrderData = createBytesCodec<UnpackedOrder, PackableOrder>({
    pack: (unpacked) => {
        return bytes.concat(UdtData.pack(unpacked), PartialOrderData.pack(unpacked));
    },
    unpack: (packed): UnpackedOrder => {
        const packedUdtData = packed.slice(0, UdtData.byteLength)
        const packedOrderData = packed.slice(UdtData.byteLength)

        const udtData = UdtData.unpack(packedUdtData);
        const orderData = PartialOrderData.unpack(packedOrderData);

        return { ...udtData, ...orderData };
    },
});

export const OutPoint: ObjectLayoutCodec<{
    txHash: FixedBytesCodec<string, BytesLike>;
    index: FixedBytesCodec<string, number | string | bigint>;
}> & Fixed = OP;