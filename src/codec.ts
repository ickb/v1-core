import { bytes, createBytesCodec } from '@ckb-lumos/codec';
import type { PackParam, UnpackResult } from '@ckb-lumos/codec';
import { UdtData, PartialOrderData } from './encoding.js';

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